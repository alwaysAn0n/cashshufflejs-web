# cashshufflejs-web

A javascript Cashshuffle client for use in front-end web applications and the browser.

**WARNING**
This client is a work in progress and currently does not shuffle any coins.  It only supplies a "dummy class" that mimicks the functionality that the completed version will provide.  This is being provided to allow cashshuffle web-app developers to start building their integrations while the final version of this library is being completed.  Comments, suggestions, and pull requests are very much welcome!

### Usage

```

var myClient = new ShuffleClient({
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

  serverUri: 'wss://shuffle.servo.cash:1337',
  protocolVersion: 100,
  serverStatsUri: 'https://shuffle.servo.cash:8080/stats',
  maxShuffleRounds: 4,
  disableAutoShuffle: true
});


myClient.on('shuffle', function(shuffleRoundData) {

  var shuffledCoin = shuffleRoundData.new;

  var changeFromShuffle = shuffleRoundData.change;

});

myClient.start();

```

### Client options

##### `coins`
> Collection

Collection of bitcoin utxos that the user intends to shuffle.  Currently all fields are required (but not validated).  In the completed version only `privateKey`, `txid`, and `vout` will be required. Everything else will be populated from the blockchain.

##### `protocolVersion`
> Integer

The client should only connect to pools following this version of the cashshuffle protocol.

##### `serverUri`
> String

Ignore this.  It won't be needed in the completed version.

##### `serverStatsUri`
> String

The URI for the cashshuffle server's `/stats` endpoint which provides the client with a list of available shuffling pools. 

##### `maxShuffleRounds`
> Integer > 0

##### `disableAutoShuffle`
> Boolean

Should the client immediately start shuffling?

### Documentation

Check out the docs in `./docs`

##### TODO!