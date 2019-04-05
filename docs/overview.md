# Overview

### Testing

```
const ShuffleClient = require('../cashshufflejs-web');
const repl = require('repl');
const shuffleIt = repl.start('cashshuffle > ');

shuffleIt.context.client = new ShuffleClient({
  coins: [{
    cashAddress: 'bitcoincash:qr7u5383gw5ckyls29mlpralgj23w4pgvc7rp7kphs',
    privateKey: 'L4QLJkku7 ... fG1LGaXWaA',
    txid: '544c6ea203b16ccad7aa61ab89fd7f9c5927a73046df78b67f0f0c7e78d39afd',
    vout: 1,
    amountSatoshis: 666000
  }],
  serverUri: 'ws://localhost:1338',
  protocolVersion: 300,
  serverStatsUri: 'http://localhost:8080/stats',
  maxShuffleRounds: 1
});

```
