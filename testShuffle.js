const ShuffleClient = require('../cashshufflejs-web');

const JsonWallet = require('./JsonWallet.js');

const _ = require('lodash');

const repl = require('repl');
const shuffleIt = repl.start('cashshuffle > ');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const myWallet = new JsonWallet({
  file: './test_json_wallet.js'
});

// Unfreeze any frozen addresses
myWallet.unfreezeAddresses( _.map(myWallet.addresses, 'cashAddress') );

// Load up our on-disk HD wallet
shuffleIt.context.wallet = myWallet;

// The two functions below provide us a way
// of plugging the `ShuffleClient` into our
// bitcoin wallet software.  They are called
// by the client when new payment addresses
// are needed during shuffle operations.

// This function should return a single new change
// address when called.  We pass this function as
// a parameter to our `ShuffleClient` instance so
// that it may fetch change addresses as needed.
const newChangeAddressFromWallet = function() {
  return myWallet.fresh.change();
};

// Ditto but for shuffled coins.  The on-disk wallet
// is using a dedicated HD path for all shuffled coins.
// I think you should too!
const newAddressForShuffledCoin = function() {
  return myWallet.fresh.shuffle();
};


const grabCoinToShuffle = async function() {

  let oneCoin;
  while (!oneCoin) {
    oneCoin = _.find(_.shuffle(myWallet.coins.slice(0,8)), {
    // oneCoin = _.find(myWallet.coins.reverse(), {
      frozen: false
    });

    if (oneCoin) {
      myWallet.freezeAddresses(oneCoin.cashAddress);
      continue;
    }
    else {
      // console.log('...');
      await delay(750);
    }
  }

  return oneCoin;
};


const addClientToShuffle = async function(clientNumber) {

  let clientName = 'client'+clientNumber;

  console.log(`Adding ${clientName} to the shuffle`);

  shuffleIt.context[clientName] = new ShuffleClient({
    coins: [],
    hooks: {
      change: newChangeAddressFromWallet,
      shuffled: newAddressForShuffledCoin
    },
    protocolVersion: 300,
    maxShuffleRounds: 1,
    // Disable automatically joining shuffle rounds
    // once a connection with the server is established
    disableAutoShuffle: true,
    serverStatsUri: 'http://localhost:8080/stats'
  });


  // This event is emitted only when a successful shuffle round occurs.
  // Currently all change is re-added to the client's pool of unshuffled
  // coins (but in the new address returned by the HD wallet hook) so
  // they too can be shuffled.  Here you would do things like un-freeze
  // shuffled coins, update UI's, etc.
  shuffleIt.context[clientName].on('shuffle', async(shuffleRound) => {

    console.log(`Coin ${ shuffleRound.coin.txid}:${ shuffleRound.coin.vout } has been successfully shuffled!`);

    let coinsToUnfreeze = _.map([ shuffleRound.change, shuffleRound.shuffled ], 'cashAddress');

    // Just a random delay to more equally distribute
    // the load on the bitcoin.com servers.
    await delay(Math.random()*1000+570);

    try {
      await myWallet.updateAddresses()
    }
    catch(nope) {
      console.log('Somethings gone wrong', nope);
      // process.exit();
    }

    myWallet.unfreezeAddresses( coinsToUnfreeze );
    shuffleIt.context[clientName].addUnshuffledCoins([ await grabCoinToShuffle() ]);

  });

};


myWallet
.updateAddresses()
.catch((someError) => {
  console.log('Error building coin info from wallet:', someError);
  throw(someError);
})
.then(async (updatedWallet) => {

  let numberOfClients = 1;
  while (numberOfClients > 0) {

    try {
      await addClientToShuffle(numberOfClients)
    }
    catch(nope) {
      console.log('Cannot add new client to shuffle:', nope);
      // process.exit();
    }

    await delay(Math.random()*1000+500);

    numberOfClients--;
  }

});
