# cashshufflejs-web

A javascript Cashshuffle client for use in front-end web applications and the browser.  This library is based on the excellent CashShuffle work by https://github.com/clifordsymack/ .

**WARNING**
This client is in early alpha release.  Beware! Comments, suggestions, and pull requests are very much welcome!

### Usage

```

const myClient = new ShuffleClient({
  coins: [
    {
      cashAddress: 'bitcoincash:qr7u5383gw5ckyls29mlpralgj23w4pgvc7rp7kphs',
      privateKey: 'abc123',
      txid: 'ca7cd24835a00310634f2115d0182ea5eef622c4a8876a7093939dda46ab5dc5',
      vout: 0,
      amountSatoshis: 3258390
    },
    {
      cashAddress: 'bitcoincash:qr7lekud8kkn3zamyedsf55n383c4zvv6s0t8m69fl',
      privateKey: 'abc123',
      txid: '02e79254e96885db1853efe8712898853cc6888320db69fa1fe04997dc15d872',
      vout: 0,
      amountSatoshis: 1629195
    }
  ],
  hooks: {
    change: function(){
      // Insert custom address generation logic here
      return newAddressForChange;
    },
    shuffled: function() {
      // Insert custom address generation logic here
      return newAddressForMyShuffledCoin;
    }
  },
  protocolVersion: 300,
  serverStatsUri: 'https://shuffle.servo.cash:8080/stats',
  maxShuffleRounds: 1,
  disableAutoShuffle: true
});

myClient.on('shuffle', function(shuffleRoundData) {

  const myShuffledCoin = shuffleRoundData.shuffled;

  const changeFromShuffle = shuffleRoundData.change;

});

this.emit('skipped', function(coinObject) {
  // Emitted when a coin is too small to shuffle or if it is
  // otherwise incompatible with the client and/or protocol.
});


// Starts shuffling coins.  Only necessary if the `disableAutoShuffle`
// flag was set to true or if you've called `myClient.stop`
myClient.start();

// Stops the client from joining new shuffle rounds.
myClient.stop();

```

### Client options

##### `coins`
> Collection

Collection of bitcoin utxos that the user intends to shuffle.  Currently all fields are required (but not validated).  In the completed version only `privateKey`, `txid`, and `vout` will be required. Everything else will be populated from the blockchain.

##### `protocolVersion`
> Integer

The client should only connect to pools following this version of the cashshuffle protocol.

##### `serverStatsUri`
> String

The URI for the cashshuffle server's `/stats` endpoint which provides the client with a list of available shuffling pools. 

##### `maxShuffleRounds`
> Integer greater than 0

This sets the number of simoultanious shuffle rounds the client will join.

##### `disableAutoShuffle`
> Boolean

Should the client immediately start shuffling? `false` by default.

### Documentation

Check out the docs in `./docs`

##### TODO!


### Roadmap

- Tests!!!
- Build for use in browser
