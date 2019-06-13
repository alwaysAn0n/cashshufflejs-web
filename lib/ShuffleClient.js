const EventEmitter = require('events').EventEmitter;

const URL = require('url').URL;
const ShuffleRound = require('./ShuffleRound.js');
const axios = require('axios');
const cryptoUtils = require('./cryptoUtils.js');
const coinUtils = require('./coinUtils.js');
const _ = require('lodash');
const debug = require('debug')('cashshufflejs-web');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const url = require('url');

class ShuffleClient extends EventEmitter {
  constructor(clientOptions) {
    super();

    for (let oneOption in clientOptions) {
      this[oneOption] = clientOptions[oneOption];
    }

    this.maxShuffleRounds = this.maxShuffleRounds ? this.maxShuffleRounds : 5;

    // Set the default protocol version to 300.
    this.protocolVersion = clientOptions.protocolVersion || 300;

    this.coins = this.coins && this.coins.length ? this.coins : [];

    // Add necessary properties to the coins
    // so the shuffle libraries can use them.
    let coinsToPopulate = [];
    while (this.coins.length) {
      coinsToPopulate.push(this.coins.pop());
    }

    this.hooks = this.hooks || {};

    if (!_.isFunction(this.hooks.change)) {
      debug(`A valid change generation hook was not provided!`);
      throw new Error('BAD_CHANGE_FN');
    };

    if (!_.isFunction(this.hooks.shuffled)) {
      debug(`A valid shuffle address generation hook was not provided!`);
      throw new Error('BAD_SHUFFLE_FN');
    };

    this.rounds = [];

    this.shuffled = [];

    this.skipped = [];

    this.isShuffling = false;

    this.util = {
      // Tools for encryption and message sign/verify
      crypto: cryptoUtils,
      // Tools that make REST calls for blockchain data
      coin: coinUtils
    };

    // TODO: Add option to prioritize coin selection
    // to either minimize coins vs maximize shuffle speed
    // this.shufflePriority = this.shufflePriority ? this.shufflePriority : 'amount';

    this.statsIntervalId;

    // These will be used to manage a "soft shutdown"
    // i.e. Not aborting active rounds.
    this._shutdownForceAbort;
    this._shutdownIntervalId;

    // Server Stats fetched from the `/stats` endpoint
    this.serverStats = {
    };

    // If we every try and fail to reach the server, this
    // number will be populated with the amount of time
    // the client will wait in between reconnection attempts.
    // It is measured in miliseconds.
    this.serverBackoffMs = 0;

    // In satoshis
    this.shuffleFee = 270;

    this.serverPoolAmounts = [
      1000000000, // 10.0    BCH ➡➡
      100000000,  //  1.0    BCH ➡
      10000000,   //  0.1    BCH ➝
      1000000,    //  0.01   BCH ➟
      100000,     //  0.001  BCH ⇢
      10000      //  0.0001 BCH →
    ];

    // This flag gets set to true if the server becomes unreachable
    // after we've started shuffling.  We will use it in our auto-
    // reconnect logic.
    this.lostServerConnection = false;

    this._shuffleIntervalId;

    const shuffleIntervalFn = () => {
      if (this._shutdownForceAbort) {
        debug('Cannot shuffle while ShuffleClient is shutting down');
        return false;
      }

      // If we have a connection error, wait a while
      // then try again.  Don't exit this loop.
      if (!this.serverBackoffMs) {

        if (this.coins.length && this.rounds.length < this.maxShuffleRounds) {

          // Here we can add logic that considers this client's
          // `maxShuffleRounds` param when selecting a coin to
          // shuffle.

          let coinToShuffle = _.maxBy(this.coins, 'amountSatoshis');

          // Determine the pools this coin is eligible to shuffle in
          let eligiblePools = _.partition(this.serverPoolAmounts, (onePoolAmount) => {
            let amountAfterFee = coinToShuffle.amountSatoshis-this.shuffleFee;
            return amountAfterFee >= onePoolAmount;
          })[0];

          // If the value of the coin is less than the lowest
          // pool size on this server, deem it unshufflable.
          if (!eligiblePools.length) {
            this.skipCoin(coinToShuffle);
            this.emit('skipped', _.extend(coinToShuffle, {
              error: 'dust'
            }));
            return;
          }

          let poolsUsingOurVersion = _.filter(this.serverStats.pools, { version: this.protocolVersion });

          // Get a list of the pools in which we have an active shuffle round
          let poolsInUse = _.map( _.filter(this.rounds, { done: false }), 'poolAmount');

          // Remove any pool that we have an active round in
          let poolsWeCanUse = _.difference(eligiblePools, poolsInUse);

          let eligiblePoolsWithPlayers = _.intersection(poolsWeCanUse, _.map(poolsUsingOurVersion, 'amount'));

          let poolToUse = _.max( eligiblePoolsWithPlayers.length ? eligiblePoolsWithPlayers : poolsWeCanUse );

          if (!poolToUse) {
            debug('No pools to join.  Trying again later.');
            return;
          }

          if (!(this.serverStats && this.serverStats.shuffleWebSocketPort) ) {
            debug('Cannot find shuffle server information');
            return;
          }

          let serverUri = this.serverUri;

          if (!serverUri) {
            const serverStatsUriParsed = url.parse(this.serverStatsUri);

            Object.assign(serverStatsUriParsed, {
              protocol: serverStatsUriParsed.protocol.replace(/^http(s?):/, 'ws$1:'),
              port: this.serverStats.shuffleWebSocketPort,
              pathname: ''
            });

            serverStatsUriParsed.host = serverStatsUriParsed.host.replace(/(:\d{1,})/,':'+serverStatsUriParsed.port);
            serverUri = serverStatsUriParsed.format();

          }
          // debug('Starting new round in:', serverUri);
          try {
            this.startNewRound(coinToShuffle, poolToUse, serverUri);
          }
          catch(nope) {
            debug('Cannot shuffle coin:', nope);
            return;
          }

        }
        else {
          // debug('no coins to shuffle', this.coins.length, this.rounds.length,  this.maxShuffleRounds);
        }

      }
      else {
        this.lostServerConnection = true;
      }

    };

    // This is the actual function that is called by setInterval every
    // 5 seconds.  It also enforces server back-off for a persistent
    // lost connection.
    this.checkStatsIntervalFn = () => {

      this
      .updateServerStats()
      .then((statsObject) => {

        if (!this.disableAutoShuffle || this.isShuffling) {
          this.isShuffling = true;
          if (!this.lostServerConnection && !this._shuffleIntervalId && !this._shutdownIntervalId){
            this._shuffleIntervalId = setInterval(shuffleIntervalFn, 5000)
          }
        }
        this.lostServerConnection = false;
      })
      .catch((error) => {
        let serverBackoffSeconds = Math.floor(this.serverBackoffMs/1000);
        debug('No server. Waiting', serverBackoffSeconds, 'seconds before reconnecting:', (error&&error.message));
        clearInterval(this.statsIntervalId);
        delay(this.serverBackoffMs)
        .then(() => {
          this.setServerStatsInterval();
        });
      });

    };

    // Re-fetch the server stats every 5 seconds so we can
    // make an informed decision about which pools to join!
    this.setServerStatsInterval = () => {
      if (this.statsIntervalId) {
        clearInterval(this.statsIntervalId);
      }
      this.statsIntervalId = setInterval(this.checkStatsIntervalFn, 5000);
      this.checkStatsIntervalFn();
    };

    this.setServerStatsInterval();

    if (coinsToPopulate.length) {
      this.addUnshuffledCoins(_.orderBy(coinsToPopulate, ['amountSatoshis'], ['desc']));
    }

    return this;
  }


  // Skip a coin that is deemed unshufflable.  This
  // normally occurs when utxos are at or below the
  // dust threshold.
  skipCoin(someCoin) {

    // Remove the coin from the pool of available coins.
    let coinToSkip = _.remove(this.coins, someCoin)[0];

    if (!coinToSkip) {
      throw new Error('coin_not_found');
    }

    this.skipped.push(coinToSkip);
    return;
  }

  // Instantiate new round and add it to our round array
  // Set the event listeners so we know when a round has
  // ended and needs cleanup
  async startNewRound(someCoin, poolAmount, serverUri) {

    // Remove the coin from the pool of available coins.
    let coinToShuffle = _.remove(this.coins, someCoin)[0];

    if (!coinToShuffle) {
      throw new Error('coin_not_found');
    }

    let newShuffleRound = new ShuffleRound({
      util: this.util,
      hooks: this.hooks,
      serverUri: serverUri,
      coin: coinToShuffle,
      protocolVersion: this.protocolVersion,
      poolAmount: poolAmount,
      shuffleFee: this.shuffleFee
    });

    // Emit an event when the phase of a round changes
    newShuffleRound.on('phase', (somePhaseData) => {

      this.emit('phase', somePhaseData);

    });

    // Emit an event when a ShuffleRound receives a message
    newShuffleRound.on('message', (someData) => {

      this.emit('message', someData);

    });

    // When a shuffle round ends, successfully or not.
    newShuffleRound.on('shuffle', this.cleanupCompletedRound.bind(this));

    // Pass any debug messages from our shuffleround instances
    // to any listeners on the shuffleClass instance.
    newShuffleRound.on('debug', (someShuffleRoundMessage) => {

      this.emit('debug', someShuffleRoundMessage);
      
    });

    debug('\n\nAttempting to mix a', newShuffleRound.coin.amountSatoshis, 'satoshi coin on', newShuffleRound.serverUri,'\n');

    this.rounds.push(newShuffleRound);
  }

  cleanupCompletedRound(shuffleRoundObject) {

    if (!shuffleRoundObject) {
      return;
    }

    // Remove the coin from the pool of available coins.
    debug('removing round', shuffleRoundObject.session, 'from rounds:', _.map(this.rounds, 'session'));
    // TODO: Make this removal criteria more specific in case of
    // the insanely unlikely case where the server gives us the
    // same sessionId for two simultaneously open rounds`
    let deadRound = _.remove(this.rounds, { session: shuffleRoundObject.session });

    let roundErrorShortCode = _.get(shuffleRoundObject, 'roundError.shortCode');

    // If successful, add the clean coin to our shuffled coin
    // array and emit an event on the client so anyone watching
    // can take the appropriate action.
    if (!roundErrorShortCode) {

      // debug(`Adding ${shuffleRoundObject.shuffled}`);

      // Put the newly shuffled coin in the "shuffled" array
      this.shuffled.push(shuffleRoundObject.shuffled);

      // Try and shuffle any change outputs 
      // 
      // ( HELP!  Should this be configurable? Idfk )
      //
      // if (shuffleRoundObject.change && shuffleRoundObject.change.usedInShuffle && this.reshuffleChange) {
      //   this.coins.push(shuffleRoundObject.change);
      // }

      // Only emit an event on the `ShuffleClient` class
      // if our shuffle was actually successful.
      this.emit('shuffle', shuffleRoundObject);

    }

    // Handle cleanup for when our round ends due to a
    // protocol violation or an exception is thrown.
    //
    // This error object takes the form below
    //
    //   {
    //     shortCode: 'BAD_SIG',
    //     errorObject: [ Error instance containing a stacktrace ],
    //     isProtocolError: true,
    //     isException: false,
    //     accusedPlayer: [ Object containing player data ]
    //   }
    //
    // TODO: Add logic for segregating coins that fail to shuffle
    // because they are deemed unshufflable by our peers or by
    // this library.
    else {
      debug(`Round failed with code ${ shuffleRoundObject.roundError.shortCode }`);

      switch(roundErrorShortCode) {
        case 'USER_ABORT':
          this.emit('abort', shuffleRoundObject);
        break;
        case 'COMMS_DISCONNECT':
          this.emit('failed', shuffleRoundObject);
        break;
        case 'ROUND_TIMEOUT':
          this.emit('failed', shuffleRoundObject);
          // Push this coin back onto our stack of coins
          // needing to be shuffled.
          if (shuffleRoundObject.coin) {
            debug('Re-trying coin:', shuffleRoundObject.coin, 'after round timeout');
            this.coins.push(shuffleRoundObject.coin);
          }
        break;
        default:
          this.emit('failed', shuffleRoundObject);
        break;
      }
      return;
    }

  }

  start() {

    if (this._shutdownForceAbort) {
      debug('Cannot start ShuffleClient while it is shutting down');
      return false;
    }

    if (this.isShuffling) {
      if (this._shuffleIntervalId) {
        debug('ShuffleClient already started');
        return true;
      }
    }

    this.stop(true);
    this.isShuffling = true;
    this.setServerStatsInterval();
    debug('Starting ShuffleClient');

    return true;
  }

  stop(abortRounds) {


    if (this.isShuffling) {
      debug('Shutting down ShuffleClient');
      this.isShuffling = false;
    }

    // Stop updating CashShuffle server stats
    if (this.statsIntervalId) {
      clearInterval(this.statsIntervalId);
      this.statsIntervalId = undefined;
    }

    // Stop trying to shuffle new coins.
    if (this._shuffleIntervalId) {
      clearInterval(this._shuffleIntervalId);
      this._shuffleIntervalId = undefined;
    }

    // If this wasn't a hard shutdown, check every 15 seconds to see 
    // if all of our active shuffle rounds have finished then emit the
    // `stopped` event once they have.  If they don't finish within
    // three minutes, abort them anyway.  At least we tried.
    if (!abortRounds && this.rounds.length) {
      this._shutdownForceAbort = new Date().getTime()+1000*180;
      this._shutdownIntervalId = setInterval(() => {

        let timeHasExpired = new Date().getTime() > this._shutdownForceAbort;

        if (timeHasExpired || !this.rounds.length) {

          if (timeHasExpired) {
            for (let oneRound of this.rounds) {
              oneRound.abortRound();
            }
          }

          this.emit('stopped', { message: 'ShuffleClient has stopped'});
          this._shutdownForceAbort = undefined;
          clearInterval(this._shutdownIntervalId);
          this._shutdownIntervalId = undefined;
        }
      }, 1000*15);

      return false;

    }
    else {

      while (this.rounds.length) {
        let grabRound = this.rounds.pop();
        try{
          grabRound.abortRound();
        }
        catch(nope) {
          debug('Failed to abort round:', grabRound);
        }
      }

      this.emit('stopped', { message: 'ShuffleClient has stopped'});

      return true;

    }

  }

  addUnshuffledCoins(oneOrMoreCoins) {

    if (this._shutdownForceAbort) {
      debug('Cannot add coins while ShuffleClient is shutting down');
      return false;
    }

    // This accepts single coin objects or arrays of them.
    // Always make sure we're processing them as arrays.
    oneOrMoreCoins = _.isArray(oneOrMoreCoins) ? oneOrMoreCoins : [ oneOrMoreCoins ];

    for (let oneCoin of oneOrMoreCoins) {
      if (!oneCoin.amountSatoshis || oneCoin.amountSatoshis < 10000+this.shuffleFee) {
        debug(`Skipping coin ${oneCoin} because it's just dust`);
        this.skipped.push( _.extend(oneCoin, { shuffled: false, error: 'size' }) );
      }

      try {
        // Extend the coin object with `PublicKey` and `PrivateKey`
        // instances from the `bitcoinjs-fork` library.  They will
        // be used for transaction signing and verification.
        let keypair = this.util.coin.getKeypairFromWif(oneCoin.privateKeyWif);
        _.extend(oneCoin, {
          publicKey: keypair.publicKey,
          privateKey: keypair.privateKey,
          cashAddress: keypair.publicKey.toAddress()._toStringCashAddr()
        });
        this.coins.push(oneCoin);
      }
      catch(nope) {
        debug('Cannot populate coin for shuffling:', nope);
        continue;
      }

    }

    return true;

  }

  // Change the Cashshuffle server this client will use
  // in future shuffle rounds.  All pending shuffle rounds
  // will use whichever server it started with.
  async changeShuffleServer(someServerUri) {

    try {
      await this.updateServerStats(someServerUri)
    }
    catch(nope) {
      debug('Error changing servers:', nope);
      throw nope;
    }

    return true;

  }

  async updateServerStats(newServerUri) {

    let serverStats;
    try {
      serverStats = await axios.get( ( newServerUri ? newServerUri : this.serverStatsUri ), {
        headers: {
          'Content-Type': 'application/json'
        }
      } );
    }
    catch(nope) {

      // If we fail to reach the server, try again with
      // an increasing infrequency with the maximum time
      // between tries being 20 seconds and the minimum
      // being 5 seconds.
      this.serverBackoffMs = this.serverBackoffMs ? Math.floor( ( this.serverBackoffMs*3 )/2 ) : 5000;
      this.serverBackoffMs = this.serverBackoffMs <= 20000 ? this.serverBackoffMs : 20000; 
      debug(nope.message);
      throw nope;
    }

    if (serverStats) {

      let poolSummary = _.reduce(this.serverPoolAmounts, (keepers, onePoolAmount) => {
        // {"members":1,"amount":100000,"type":"DEFAULT","full":false,"version":300}
        let poolsForThisAmount = _.filter(serverStats.data.pools, { amount: onePoolAmount }) || [];
        keepers.push({
          amount: onePoolAmount,
          pools: poolsForThisAmount,
          versions: _.uniqBy(poolsForThisAmount, 'version'),
          numberOfPools: poolsForThisAmount.length,
          totalMembers: _.sumBy(poolsForThisAmount, 'members'),
          weAreMember: _.find(this.rounds, { poolAmount: onePoolAmount }) ? true : false
        });
        return keepers;
      }, []);

      serverStats.data.poolSummary = _.orderBy(poolSummary, ['amount'], ['desc']);
      _.extend(this.serverStats, serverStats.data);
      this.serverBackoffMs = 0;
      this.emit('stats', this.serverStats);
    }
    else {
      _.extend(this.serverStats, {
        poolSummary: []
      });
    }

    return serverStats;

  }

}

module.exports = ShuffleClient;