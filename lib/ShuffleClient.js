const EventEmitter = require('events').EventEmitter;

const URL = require('url').URL;
const ShuffleRound = require('./ShuffleRound.js');
const axios = require('axios');
const coinUtils = require('./coinUtils.js');
const _ = require('lodash');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

class ShuffleClient extends EventEmitter {
  constructor(clientOptions) {
    super();

    for (let oneOption in clientOptions) {
      this[oneOption] = clientOptions[oneOption];
    }

    this.maxShuffleRounds = this.maxShuffleRounds ? this.maxShuffleRounds : 5;

    this.coins = this.coins && this.coins.length ? this.coins : [];

    // Add necessary properties to the coins
    // so the shuffle libraries can use them.
    let coinsToPopulate = [];
    while (this.coins.length) {
      coinsToPopulate.push(this.coins.pop());
    }

    this.hooks = this.hooks || {};

    if (!_.isFunction(this.hooks.change)) {
      console.log(`A valid change generation hook was not provided!`);
      throw new Error('BAD_CHANGE_FN');
    };

    if (!_.isFunction(this.hooks.shuffled)) {
      console.log(`A valid shuffle address generation hook was not provided!`);
      throw new Error('BAD_SHUFFLE_FN');
    };

    this.addUnshuffledCoins(_.orderBy(coinsToPopulate, ['amountSatoshis'], ['desc']));

    this.rounds = [];

    this.shuffled = [];

    this.skipped = [];

    this.isShuffling = false;

    // TODO: Add option to prioritize coin selection
    // to either minimize coins vs maximize shuffle speed
    // this.shufflePriority = this.shufflePriority ? this.shufflePriority : 'amount';

    this.statsIntervalId;

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

    // This is the actual function that is called by setInterval every
    // 5 seconds.  It also enforces server back-off for a persistent
    // lost connection.
    this.checkStatsIntervalFn = async () => {

      this
      .updateServerStats()
      .then( async (statsObject) => {
        if (!this.disableAutoShuffle || this.isShuffling) {
          this.isShuffling = true;
          if (!this.lostServerConnection){
            this.shuffle.call(this);
          }
        }
        this.lostServerConnection = false;
      })
      .catch( async (error) => {
        clearInterval(this.tingId);
        console.log(`No server. Waiting ${Math.floor(this.serverBackoffMs/1000)} seconds before reconnecting`);
        await delay(this.serverBackoffMs);
        this.setServerStatsInterval();
      });

    };

    // Re-fetch the server stats every 5 seconds so we can
    // make an informed decision about which pools to join!
    this.setServerStatsInterval = async() => {
      this.tingId = setInterval(this.checkStatsIntervalFn, 5000)
      this.checkStatsIntervalFn();
    };

    this.setServerStatsInterval();

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
      hooks: this.hooks,
      serverUri: serverUri,
      coin: coinToShuffle,
      protocolVersion: this.protocolVersion,
      poolAmount: poolAmount,
      shuffleFee: this.shuffleFee
    });

    // When a shuffle round ends, successfully or not.
    newShuffleRound.on('shuffle', this.cleanupCompletedRound.bind(this));

    // Pass any debug messages from our shuffleround instances
    // to any listeners on the shuffleClass instance.
    newShuffleRound.on('debug', (someShuffleRoundMessage) => {

      this.emit('debug', someShuffleRoundMessage);
      
    });

    console.log('\n\nAttempting to mix a', newShuffleRound.coin.amountSatoshis, 'satoshi coin on', newShuffleRound.serverUri,'\n');

    this.rounds.push(newShuffleRound);
  }


  cleanupCompletedRound(shuffleRoundObject) {
    if (!shuffleRoundObject) {
      return;
    }

    // Remove the coin from the pool of available coins.

    // TODO: Make this removal criteria more specific in case of
    // the insanely unlikely case where the server gives us the
    // same sessionId for two simultaneously open rounds`
    _.remove(this.rounds, { session: shuffleRoundObject.session });

    // If successful, add the clean coin to our shuffled coin
    // array and emit an event on the client so anyone watching
    // can take the appropriate action.
    if (! _.get(shuffleRoundObject,'roundError.shortCode') ) {

      // console.log(`Adding ${shuffleRoundObject.shuffled}`);

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
    // This error property takes the form below
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
      console.log(`Round failed with code ${ shuffleRoundObject.roundError.shortCode }`);

      // Push this coin back onto our stack of coins
      // needing to be shuffled.
      this.coins.push(shuffleRoundObject.coin);
    }

  }

  async shuffle() {

    while (this.isShuffling) {

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
            continue;
          }
          // Get a list of the pools in which we have an active shuffle round
          let poolsInUse = _.map( _.filter(this.rounds, { done: false }), 'poolAmount');

          // Remove any pool that we have an active round in
          let poolsWeCanUse = _.difference(eligiblePools, poolsInUse);

          let eligiblePoolsWithPlayers = _.intersection(poolsWeCanUse, _.map(this.serverStats.pools, 'amount'));

          let poolToUse = _.max( eligiblePoolsWithPlayers.length ? eligiblePoolsWithPlayers : poolsWeCanUse );

          if (!poolToUse) {
            continue;
          }

          if (!(this.serverStats && this.serverStats.shuffleWebSocketPort) ) {
            console.log('Cannot find shuffle server information');
            continue;
          }

          let serverUri = this.serverUri;

          if (!serverUri) {
            const serverStatsUriParsed = new URL(this.serverStatsUri);

            Object.assign(serverStatsUriParsed, {
              protocol: serverStatsUriParsed.protocol.replace(/^http(s?):/, 'ws$1:'),
              port: this.serverStats.shuffleWebSocketPort,
              pathname: '',
            });

            serverUri = serverStatsUriParsed.toString();
          }

          // console.log('Starting new round in:', serverUri);
          try {
            await this.startNewRound(coinToShuffle, poolToUse, serverUri);
          }
          catch(nope) {
            console.log('Cannot shuffle coin:', nope);
            continue;
          }

        }
        else {
          // console.log('no coins to shuffle', this.coins.length, this.rounds.length,  this.maxShuffleRounds);
        }

      }
      else {
        this.lostServerConnection = true;
      }

      await delay(5000);

    }

  }

  stop() {

    if (this.isShuffling) {
      this.isShuffling = false;
    }

  }

  addUnshuffledCoins(oneOrMoreCoins) {
    // This accepts single coin objects or arrays of them.
    // Always make sure we're processing them as arrays.
    oneOrMoreCoins = _.isArray(oneOrMoreCoins) ? oneOrMoreCoins : [ oneOrMoreCoins ];

    for (let oneCoin of oneOrMoreCoins) {
      if (!oneCoin.amountSatoshis || oneCoin.amountSatoshis < 10000+this.shuffleFee) {
        console.log(`Skipping coin ${oneCoin} because it's just dust`);
        this.skipped.push( _.extend(oneCoin, { shuffled: false, error: 'size' }) );
      }

      try {
        // Extend the coin object with `PublicKey` and `PrivateKey`
        // instances from the `bitcoinjs-fork` library.  They will
        // be used for transaction signing and verification.
        let keypair = coinUtils.getKeypairFromWif(oneCoin.privateKeyWif);
        _.extend(oneCoin, {
          publicKey: keypair.publicKey,
          privateKey: keypair.privateKey
        });
        this.coins.push(oneCoin);
      }
      catch(nope) {
        console.log('Cannot populate coin for shuffling:', nope);
        continue;
      }

    }

  }

  // Change the Cashshuffle server this client will use
  // in future shuffle rounds.  All pending shuffle rounds
  // will use whichever server it started with.
  async changeShuffleServer(someServerUri) {

    try {
      await this.updateServerStats(someServerUri)
    }
    catch(nope) {
      console.log('Error changing servers:', nope);
      throw nope;
    }

    return true;

  }

  async updateServerStats(newServerUri) {

    let serverStats;
    try {
      serverStats = await axios.get( ( newServerUri ? newServerUri : this.serverStatsUri ) );
    }
    catch(nope) {

      // If we fail to reach the server, try again with
      // an increasing infrequency with the maximum time
      // between tries being 20 seconds and the minimum
      // being 5 seconds.
      this.serverBackoffMs = this.serverBackoffMs ? Math.floor( ( this.serverBackoffMs*3 )/2 ) : 5000;
      this.serverBackoffMs = this.serverBackoffMs <= 20000 ? this.serverBackoffMs : 20000; 
      console.log(nope.message);
      throw nope;
    }

    if (serverStats) {
      _.extend(this.serverStats, serverStats.data);
      this.serverBackoffMs = 0;
    }

    return serverStats;

  }

}

module.exports = ShuffleClient;