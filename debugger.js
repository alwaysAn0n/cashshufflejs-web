const repl = require('repl');

const currentPath = __filename.substring(0,__filename.lastIndexOf('/'));
process.chdir(currentPath);

const messageUtils = require('./lib/serverMessages.js');
const _ = require('lodash');

const shuffleIt = repl.start('cashshuffle debug > ');

shuffleIt.context.round;
try {
  shuffleIt.context.round = require(currentPath+'/_failedShuffle.js');
}
catch(nope) {
  console.log('No failed shuffle file found at', currentPath+'/_failedShuffle.js');
  shuffleIt.context.round = {};
}

// shuffleIt.context.players = shuffleIt.context.round.players;
shuffleIt.context.inbox = shuffleIt.context.round.inbox;
shuffleIt.context.outbox = shuffleIt.context.round.outbox;
shuffleIt.context.me = _.find(shuffleIt.context.round.players, { isMe: true });

for (let onePlayer of shuffleIt.context.round.players) {
  if (onePlayer.isMe) {
    continue;
  }
  let somePlayer = {};
  somePlayer['player'+onePlayer.playerNumber] = onePlayer;
  _.extend(shuffleIt.context, somePlayer);
}

shuffleIt.context.bch = require('bitcoincashjs-fork');
shuffleIt.context.Address = shuffleIt.context.bch.Address;
shuffleIt.context.PrivateKey = shuffleIt.context.bch.PrivateKey;
shuffleIt.context.PublicKey = shuffleIt.context.bch.PublicKey;
shuffleIt.context.Message = require('./lib/BetterMessage.js');
shuffleIt.context.msg = messageUtils;
shuffleIt.context.crypto = require('./lib/cryptoUtils.js');
shuffleIt.context._ = _;

shuffleIt.context.tools = {
  crypto: require('./lib/cryptoUtils.js'),
  coin: require('./lib/coinUtils.js'),
  // Find a properly packed `Protocol Message` from
  // somewhere deep inside a base64 encoded string.
  findValidPackets: function(someBase64EncodedString) {

    let messageBuffer = Buffer.from(someBase64EncodedString, 'base64');

    let aintGood = true;
    let indexCounter=0;
    let packets;
    let numTries = 0;
    while (aintGood && numTries < someBase64EncodedString.length) {
      numTries++;
      try {

        let messageMagic = messageBuffer.slice(indexCounter, indexCounter+8);
        if (messageMagic.toString('hex') !== magic.toString('hex')) {
          indexCounter += 1;
          throw new Error('message_magic:'+(messageMagic.toString('hex')));
        }
        else {
          packets = shuffleIt.context.crypto.PB.Packets.decode(messageBuffer.slice(indexCounter+12, )).toJSON();
          aintGood = false;
        }

      }
      catch(nope) {

      }

    }

    console.log(JSON.stringify(packets,null,4));

    return packets;
  }
};