const EventEmitter = require('events').EventEmitter;

const ShuffleRound = require('./ShuffleRound.js');
const axios = require('axios');
const coinUtils = require('./coinUtils.js');
const _ = require('lodash');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

class ShuffleClient extends EventEmitter {
  constructor(clientOptions) {
    super();
    // this.emit('debug', {message:'setup', this: this});
    // Persist client options 
    for (let oneOption in clientOptions) {
      this[oneOption] = clientOptions[oneOption];
    }
    // console.log(this);

    this.maxShuffleRounds = this.maxShuffleRounds ? this.maxShuffleRounds : 5;

    this.coins = this.coins && this.coins.length ? this.coins : [];

    // Add necessary properties to the coins
    // so the shuffle libraries can use them.
    let coinsToPopulate = [];
    while (this.coins.length) {
      coinsToPopulate.push(this.coins.pop());
    }
    this.addUnshuffledCoins(coinsToPopulate);

    this.rounds = [];

    this.shuffled = [];

    this.skipped = [];

    this.isShuffling = false;

    this.shufflePriority = this.shufflePriority ? this.shufflePriority : 'amount';

    this.updateServerStatsInterval;

    // Server Stats fetched from the `/stats` endpoint
    this.serverStats = {
    };

    // In satoshis
    this.serverShuffleFee = 270;

    this.serverPoolAmounts = [
      1000000000, // 10.0    BCH ➡➡
      100000000,  //  1.0    BCH ➡
      10000000,   //  0.1    BCH ➝
      1000000,    //  0.01   BCH ➟
      100000,     //  0.001  BCH ⇢
      10000      //  0.0001 BCH →
    ];

    this
    .updateServerStats()
    .catch( (error) => {

      throw error;

    })
    .then( () => {

      // Re-fetch the server stats every 5 seconds so we can
      // make an informed decision about which pools to join!
      this.updateServerStatsInterval = setInterval(() => {

        this
        .updateServerStats()
        .catch( (someError) => {
          this.isShuffling = false;
        })
        .then( () => {
          return;
        });

      }, 5000);

      if (this.coins && this.coins.length) {
        if (!this.disableAutoShuffle) {
          this.isShuffling = true;
          this.shuffle.call(this);
        }
      }

    });

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
  async startNewRound(someCoin, poolAmount) {

    // Remove the coin from the pool of available coins.
    let coinToShuffle = _.remove(this.coins, someCoin)[0];

    if (!coinToShuffle) {
      throw new Error('coin_not_found');
    }

    let newShuffleRound = new ShuffleRound({
      serverUri: this.serverUri,
      coin: coinToShuffle,
      protocolVersion: this.protocolVersion,
      poolAmount: poolAmount
    });

    newShuffleRound.on('shuffle', this.cleanupCompletedRound.bind(this));

    // Pass any debug messages from our shuffleround instances
    // to any listeners on the shuffleClass instance.
    newShuffleRound.on('debug', (someShuffleRoundMessage) => {

      this.emit('debug', someShuffleRoundMessage);
      
    });

    console.log('Attempting to mix a', newShuffleRound.coin.amountSatoshis, 'satoshi coin on', newShuffleRound.serverUri);

    this.rounds.push(newShuffleRound);
    this.rounds.push({poolAmount: poolAmount, done: false });
  }


  cleanupCompletedRound(shuffleRoundObject) {
    if (!shuffleRoundObject) {
      return;
    }
    else {
      console.log('Round is complete');
    }

    // Remove the coin from the pool of available coins.
    let completedRound = _.remove(this.rounds, { session: shuffleRoundObject.session })[0];

    // If successful, add the clean coin to our shuffled coin
    // array and emit an event on the client so anyone watching
    // can take the appropriate action.
    if (!completedRound.error) {

      console.log('Round successful.  Adding', completedRound.new);
      // Put the newly shuffled coin in the "shuffled" array
      this.shuffled.push(completedRound.new);

      // Try and shuffle any change outputs 
      if (completedRound.change) {
        this.coins.push(completedRound.change);
      }

    }
    else {
      console.log('Round failed.  Trying again');
      this.coins.push(completedRound.coin);
    }

    this.emit('shuffle', completedRound);
    process.exit();
  }


  async shuffle() {

    while (this.isShuffling) {

      if (this.coins.length && this.rounds.length < this.maxShuffleRounds) {

        let coinToShuffle = _.maxBy(this.coins, 'amountSatoshis');

        // Determine the pools this coin is eligible to shuffle in
        let eligiblePools = _.partition(this.serverPoolAmounts, (onePoolAmount) => {
          let amountAfterFee = coinToShuffle.amountSatoshis-this.serverShuffleFee;
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

        try {
          await this.startNewRound(coinToShuffle, poolToUse);
        }
        catch(nope) {
          console.log('Cannot shuffle coin:', nope);
          continue;
        }

      }
      else {
        // console.log('no coins to shuffle', this.coins.length, this.rounds.length,  this.maxShuffleRounds);
      }

      await delay(5000);

    }

  }

  stop() {

    if (this.isShuffling) {
      this.isShuffling = false;
      // Kill our server stats interval
    }

  }

  addUnshuffledCoins(oneOrMoreCoins) {
    // This accepts single coin objects or arrays of them.
    // Always make sure we're processing them as arrays.
    oneOrMoreCoins = _.isArray(oneOrMoreCoins) ? oneOrMoreCoins : [ oneOrMoreCoins ];

    // TODO: Add type checking.  Return our results and
    // include errors for coins that couldn't be populated.
    for (let oneCoin of oneOrMoreCoins) {
      if (!oneCoin.amountSatoshis || oneCoin.amountSatoshis < 10000+this.serverShuffleFee) {
        this.skipped.push( _.extend(oneCoin, { shuffled: false, error: 'size' }) );
      }

      try {
        this.coins.push( _.extend(oneCoin, coinUtils.buildCoinFromPrivateKey(oneCoin.privateKey) ) );
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

    this.serverUri = someServerUri;

    return true;

  }

  async updateServerStats(newServerUri) {

    let serverStats;
    try {
      serverStats = await axios.get( ( newServerUri ? newServerUri : this.serverStatsUri ) );
    }
    catch(nope) {
      console.log('Error updating server stats:', nope.message);

      // TODO: If we have active shuffling rounds,
      // let the server cool off then try again
      // later.
      if (!this.rounds.length) {
        throw nope;
      }

    }

    if (!serverStats) {
      return;
    }

    _.extend(this.serverStats, serverStats.data);

    return serverStats;

  }

}

module.exports = ShuffleClient;