const bch = require('bitcoincashjs-fork');

const PublicKey = bch.PublicKey;

const BchMessage = require('./BetterMessage.js');

const _ = require('lodash');

const magic = Buffer.from('42bcc32669467873', 'hex');

// Set up our protobuff classes
const protobuf = require('protobufjs');

const pbEnums = ['Phase', 'Reason'];

const pbTypes = [
  'Signed', 'Packet', 'Coins', 'Signatures', 'Message', 'Address',
  'Registration', 'VerificationKey', 'EncryptionKey', 'DecryptionKey',
  'Hash', 'Signature', 'Transaction', 'Blame', 'Invalid', 'Inputs',
  'Packets'];

const PB = {
  root: protobuf.loadSync(__dirname+'/message.proto')
};

for (let oneClassName of pbTypes) {
  PB[oneClassName] = PB.root.lookupType(oneClassName);
}

for (let oneClassName of pbEnums) {
  PB[oneClassName] = PB.root.lookupEnum(oneClassName);
}

function messageToBuffers(someBase64Message) {
  let messageBuffer = Buffer.from(someBase64Message, 'base64');

  if (messageBuffer.length < 12) {
    throw new Error('bad_length');
  }
  else {

    let messageMagic = messageBuffer.slice(0, 8);

    if (messageMagic.toString('hex') !== magic.toString('hex')) {
      throw new Error('message_magic');
    }

    let messageLength = messageBuffer.slice(8, 12);
    messageLength = messageLength.readUInt32BE();

    let messagePayload = messageBuffer.slice(12, );

    if (messagePayload.length !== messageLength) {
      console.log('Incorrect payload size:', messagePayload.length, '!==', messageLength);
      throw new Error('message_payload');
    }
    else {

      return {
        magic: messageBuffer.slice(0, 8).toString('base64'),
        length: messageBuffer.slice(8, 12).toString('base64'),
        payload: messageBuffer.slice(12, ).toString('base64'),
        buffer: messageBuffer.toString('base64')
      }

    }
  }
}

// TODO: Clean this up so it better handles
// multi-packet messages.
function decodeAndClassify(messageBuffer) {

  if (messageBuffer.length < 12) {
    throw new Error('bad_length');
  }
  else {

    let messageMagic = messageBuffer.slice(0, 8);

    if (messageMagic.toString('hex') !== magic.toString('hex')) {
      throw new Error('message_magic');
    }

    let messageLength = messageBuffer.slice(8, 12);
    messageLength = messageLength.readUInt32BE();

    let messagePayload = messageBuffer.slice(12, );

    let serverMessage = {
      packets: [],
      full: undefined,
      pruned: undefined,
      components: messageToBuffers(messageBuffer)
    };

    if (messagePayload.length !== messageLength) {
      console.log('Incorrect payload size:', messagePayload.length, '!==', messageLength);
      throw new Error('message_payload');
    }
    else {

      let decodedPackets = PB.Packets.decode(messagePayload);
      for (let onePacket of decodedPackets.packet) {
        serverMessage.packets.push(onePacket);
      }

      serverMessage.full = decodedPackets.toJSON();

      serverMessage.pruned = {
        message: _.get(serverMessage.full, 'packet[0].packet'),
        signature: _.get(serverMessage.full, 'packet[0].signature.signature')
      }

    }

    if (!serverMessage.pruned.message) {
      throw new Error('message_parsing');
    }

    // TODO: Pick more intuitive and more
    // consistent message names.
    let messageTypes = [
      { name: 'playerCount', required: ['number'] },
      { name: 'serverGreeting', required: ['number','session'] },
      { name: 'announcementPhase', required: ['number','phase'] },
      { name: 'incomingVerificationKeys', required: ['session','fromKey.key','message.inputs'] },
      { name: 'incomingChangeAddress', required: ['session','number','fromKey.key','message.address.address', 'message.key.key', 'phase'] },

      // This message name will be changed before
      // the `serverMessage` event is emitted by
      // the `CommChannel` class.  We set the final
      // message name there because that's where we
      // have access to round state data and the
      // purpose of the message (which should inform
      // the name) changes based on the state of the
      // round.
      //
      // Yep, this is yet another hack to deal
      // with the fact that there is no support for a 
      // unique `messageName` field on the protocol
      // messages.
      { name: '_unicast', required: ['number','session','fromKey.key','toKey.key','message.str'] },
      { name: 'incomingEquivCheck', required: ['number', 'session', 'phase', 'fromKey.key','message.hash.hash'] },
      { name: 'incomingInputAndSig', required: ['number', 'session', 'phase', 'fromKey.key','message.signatures'] },
      { name: 'finalTransactionOutputs', required: ['session','number', 'phase', 'fromKey.key', 'message.str'] },
      { name: 'blame', required: ['number','session','fromKey.key','message.blame','phase'] }
    ];

    // Order the message types so that the most
    // specific descriptions are seen first by
    // the function that attempts to find a match.
    messageTypes = _.orderBy(messageTypes, function(ot){ return ot.required.length }, ['desc']);

    let matchingMessageType = _.reduce(messageTypes, function(winner, oneObject) {
      let requiredParamValues = _.at(serverMessage.pruned.message, oneObject.required);
      // If none of the required parameters are missing,
      // consider this object a match.
      let isMatch = oneObject.required.length === _.compact(requiredParamValues).length ? true : false;

      // If our match has more matching params than
      // our previous match, use this one instead
      if (isMatch && winner.required.length < requiredParamValues.length) {
        return oneObject;
      }
      else {
        return winner;
      }
    }, { required: [] });

    _.extend(serverMessage.pruned, {
      messageType: matchingMessageType.name || 'UNKNOWN'
    });

    return serverMessage;

  }
}

function registration(protocolVersion, amount, key) {
  if (_.isObject(key) && typeof key.toString){
    key = key.toString();
  }

  var message;
  message = PB.Signed.create({
    packet: PB.Packet.create({
      fromKey: PB.VerificationKey.create({
        key: key
      }),
      registration: PB.Registration.create({
        amount: amount,
        // type: "DEFAULT",
        version: protocolVersion
      })
    })
  });

  return packMessage(message);
}

// This function reveals the coin our client wishes to
// shuffle as well as our verificationKey.  Although we
// revealed our verificationKey in our server registration
// message, that message isn't relayed to our peers.  This
// is the first message where our peers see the vk.
function broadcastTransactionInput(inputsObject, session, playerNumber, verificationPublicKey) {

  if (_.isObject(verificationPublicKey) && typeof verificationPublicKey.toString){
    verificationPublicKey = verificationPublicKey.toString();
  }

  let message;
  message = PB.Signed.create({
    packet: PB.Packet.create({
      fromKey: PB.VerificationKey.create({
        key: verificationPublicKey
      }),
      message: PB.Message.create({
        inputs: {}
      }),
      session: session,
      number: playerNumber
    })
  });

  for (let key in inputsObject) {
    message.packet.message.inputs[key] = PB.Coins.create({
      coins: inputsObject[key]
    });
  }

  return packMessage(message);
}


// {
//   "packet": [
//     {
//       "packet": {
//         "session": "aGFIYURRd0JBWFN5MkJJNnBhdzZ6OQ==",
//         "number": 2,
//         "from_key": {
//           "key": "03b9bf1605aa851945bd72e575d42f7ca874d9d7099f686c70893f927512010853"
//         },
//         "to_key": {
//           "key": "03aa863d01fd4c44043b73fccd820101f8bdc3bdf59a2472f1f1ecf6822ce4ad7b"
//         },
//         "phase": 2,
//         "message": {
//           "str": "QklFMQNiC79dSfQjlIRKY/nHYE9KblxLkT6na8kelVoL8OIHW9/QqooDxTgtNm5Xhfh3R6kMWslw+uF6sYdhYZ53ce2sJBaaRWMLO8twqjfJGBPt/97XAAIVA57KNfzJOzdx6a8e/oUZ99xKPp6MRDBPGmME"
//         }
//       },
//       "signature": {
//         "signature": "H/zYhGuMsptl9hL76Wn9ylNUmHKAzO+ZQbEHAkTPIp1aP0DiAjtvsyFmS1ZK03nTS5d5/4Vb5GoKnty7UijANds="
//       }
//     },
//     {
//       "packet": {
//         "session": "aGFIYURRd0JBWFN5MkJJNnBhdzZ6OQ==",
//         "number": 2,
//         "from_key": {
//           "key": "03b9bf1605aa851945bd72e575d42f7ca874d9d7099f686c70893f927512010853"
//         },
//         "to_key": {
//           "key": "03aa863d01fd4c44043b73fccd820101f8bdc3bdf59a2472f1f1ecf6822ce4ad7b"
//         },
//         "phase": 2,
//         "message": {
//           "str": "QklFMQJtTrG5IQiUX1C0ZR67t5cQbN4v72uSzrCOuy1QEtOI41wQ2CGGK7lgtxyS9g8tzd9YHe+4DyMaSyrCIx/Ft/U27P6dU5xR6lVhf3ekV3mIW8/vH2lpb2AWY3Djl0egotBFrIylX+2W0nC9MVaU98xZ"
//         }
//       },
//       "signature": {
//         "signature": "H8zKYj3OsPF/EUstjST/pzI8AqwcsK8OySDIxm9WABUYHWODcoBAzKsnEh1I7gLfABpAqnYkM0WK0SiyBeVUuq8="
//       }
//     }
//   ]

// this.comms.sendMessage('forwardEncryptedOutputs', [
//   this.session, me.playerNumber, encryptedOutputAddresses.success,
//   this.phase.toUpperCase(), nextPlayer.verificationKey, this.ephemeralKeypair.publicKey,
//   this.ephemeralKeypair.privateKey
// ]);
function forwardEncryptedOutputs(session, fromPlayerNumber, arrayOfOutputs, phase, toVerificationKey, myVerificationPubKey, myVerificationPrivKey) {
  if (_.isObject(myVerificationPubKey) && typeof myVerificationPubKey.toString){
    myVerificationPubKey = myVerificationPubKey.toString();
  }
  if (_.isObject(toVerificationKey) && typeof toVerificationKey.toString){
    toVerificationKey = toVerificationKey.toString();
  }

  // TODO: Make these server messages consistent with
  // respect to param validation and type checking.

  let signedMessages = [];
  for (let oneEncryptedAddress of arrayOfOutputs) {

    let message = PB.Signed.create({
      packet: PB.Packet.create({
        session: session,
        number: fromPlayerNumber,
        fromKey: PB.VerificationKey.create({
          key: myVerificationPubKey
        }),
        toKey: PB.VerificationKey.create({
          key: toVerificationKey
        }),
        phase: PB.Phase.values[phase.toUpperCase()],
        message: PB.Message.create({
          str: oneEncryptedAddress
        })
      })
    });

    let msg = PB.Packet.encode(message.packet).finish().toString('base64');
    let signature = new BchMessage(msg, 'base64').sign( bch.PrivateKey(myVerificationPrivKey) );

    message.signature = PB.Signature.create({
      signature: signature
    });

    signedMessages.push(message);
  }

  return packMessage(signedMessages);
}

// {
//   "packet": [
//     {
//       "packet": {
//         "session": "OGlTZkdsSTZUQVgwNkU4Yk4wMkowTw==",
//         "number": 1,
//         "from_key": {
//           "key": "0202135e4f7217957db961f26e3856a239e89023f6cd6088d6303775c3a61572bf"
//         },
//         "phase": 6,
//         "message": {
//           "signatures": [
//             {
//               "utxo": "3a019c3a44d5269edf8a6ca2588ead452b03f8fcdda2b622906c98e4d1d5778f:0",
//               "signature": {
//                 "signature": "MzA0NDAyMjAwYjZiYzIyMDMzZTQwYzA5ZjJhNTdiZjZhOTc1YTEwMTk0OGU5ODAzMGY2OWRjMWZhYzlmZWY5ZTk0YTcxZTMzMDIyMDY4MDFlYzMzYWZiOTU5ZDZlZGZiMDQyMDM2NzcwYjA4MjI1NzczM2ExMjBhMDdmMTgzM2RlZTdhZTUzNDhlNzM0MQ=="
//               }
//             }
//           ]
//         }
//       },
//       "signature": {
//         "signature": "H0fwrr75/6GcPzPB6etyWyZD4mLlDGacVIs/j+VTldLCdE8yAfactL8jdXrJRwE7RqYhCFJ6vIHFpTu6Xa+SW2Y="
//       }
//     }
//   ]
// }
function broadcastSignatureAndUtxo(session, fromPlayerNumber, coinUtxoData, signatureString, phase, myVerificationPubKey, myVerificationPrivKey) {
  if (_.isObject(myVerificationPubKey) && typeof myVerificationPubKey.toString){
    myVerificationPubKey = myVerificationPubKey.toString();
  }

  let message = PB.Signed.create({
    packet: PB.Packet.create({
      session: session,
      number: fromPlayerNumber,
      fromKey: PB.VerificationKey.create({
        key: myVerificationPubKey
      }),
      phase: PB.Phase.values[phase.toUpperCase()],
      message: PB.Message.create({
        signatures: []
      })
    })
  });

  message.packet.message.signatures.push(PB.Signature.create({
    utxo: coinUtxoData,
    signature: PB.Signature.create({
      signature: signatureString
    })
  }));

  let msg = PB.Packet.encode(message.packet).finish().toString('base64');
  let signature = new BchMessage(msg, 'base64').sign( bch.PrivateKey(myVerificationPrivKey) );

  message.signature = PB.Signature.create({
    signature: signature
  });

  return packMessage(message);
}


// {
//   "packet": [
//     {
//       "packet": {
//         "session": "c25hMmNwNm8xcXJIejlNMDhJdGFNZA==",
//         "number": 2,
//         "from_key": {
//           "key": "03343954c832a7b870eb8758c1c280b954bfed8b8fb65a33d52f848aabdbf31dce"
//         },
//         "phase": 4,
//         "message": {
//           "hash": {
//             "hash": "1WDdy4zstoNgSnuSjagCxL5P8aqDbBerN92WSs1c2hY="
//           }
//         }
//       },
//       "signature": {
//         "signature": "ICz+h2V5JBhHTronVb2FB4rCLHrIDi3gmsCn/+VphuojdofZBx5LCjefnnoGhwyYVQ40pSPi1u+JPXduPurrOBo="
//       }
//     }
//   ]
// }
function broadcastEquivCheck(session, fromPlayerNumber, equivCheckHash, phase, myVerificationPubKey, myVerificationPrivKey) {
  if (_.isObject(myVerificationPubKey) && typeof myVerificationPubKey.toString){
    myVerificationPubKey = myVerificationPubKey.toString();
  }

  let message = PB.Signed.create({
    packet: PB.Packet.create({
      session: session,
      number: fromPlayerNumber,
      fromKey: PB.VerificationKey.create({
        key: myVerificationPubKey
      }),
      phase: PB.Phase.values[phase.toUpperCase()],
      message: PB.Message.create({
        hash: PB.Hash.create({
          hash: equivCheckHash
        })
      })
    })
  });

  let msg = PB.Packet.encode(message.packet).finish().toString('base64');
  let signature = new BchMessage(msg, 'base64').sign( bch.PrivateKey(myVerificationPrivKey) );

  message.signature = PB.Signature.create({
    signature: signature
  });

  return packMessage(message);
}

function broadcastFinalOutputAddresses(session, fromPlayerNumber, arrayOfOutputs, phase, myVerificationPubKey, myVerificationPrivKey) {
  if (_.isObject(myVerificationPubKey) && typeof myVerificationPubKey.toString){
    myVerificationPubKey = myVerificationPubKey.toString();
  }

  let signedMessages = [];
  for (let onePlaintextAddress of arrayOfOutputs) {

    let message = PB.Signed.create({
      packet: PB.Packet.create({
        session: session,
        number: fromPlayerNumber,
        fromKey: PB.VerificationKey.create({
          key: myVerificationPubKey
        }),
        phase: PB.Phase.values[phase.toUpperCase()],
        message: PB.Message.create({
          str: onePlaintextAddress
        })
      })
    });

    let msg = PB.Packet.encode(message.packet).finish().toString('base64');
    let signature = new BchMessage(msg, 'base64').sign( bch.PrivateKey(myVerificationPrivKey) );

    message.signature = PB.Signature.create({
      signature: signature
    });

    signedMessages.push(message);
  }

  return packMessage(signedMessages);
}

function changeAddressAnnounce(session, playerNumber, changeAddress, encryptionPublicKey, phase, verificationPublicKey, verificationPrivateKey) {
  if (_.isObject(encryptionPublicKey) && typeof encryptionPublicKey.toString){
    encryptionPublicKey = encryptionPublicKey.toString();
  }
  if (_.isObject(verificationPublicKey) && typeof verificationPublicKey.toString){
    verificationPublicKey = verificationPublicKey.toString();
  }

  let message;
  message = PB.Signed.create({
    packet: PB.Packet.create({
      session: session,
      number: playerNumber,
      fromKey: PB.VerificationKey.create({
        key: verificationPublicKey
      }),
      phase: PB.Phase.values[phase.toUpperCase()],
      message: PB.Message.create({
        address: PB.Address.create({
          address: changeAddress
        }),
        key: PB.VerificationKey.create({
          key: encryptionPublicKey
        })
      })
    })
  });

  let msg = PB.Packet.encode(message.packet).finish().toString('base64');
  let signature = new BchMessage(msg, 'base64').sign( bch.PrivateKey(verificationPrivateKey) );

  message.signature = PB.Signature.create({
    signature: signature
  });
  return packMessage(message);
}

// Encode message from a prototype buffer object.
function packMessage(oneOrMorePackets) {
  oneOrMorePackets = _.isArray(oneOrMorePackets) ? oneOrMorePackets : [oneOrMorePackets];

  let packets = PB.Packets.create({ packet: oneOrMorePackets });
  let messageBuffer = PB.Packets.encode(packets).finish();
  let lengthSuffix = Buffer.alloc(4);
  lengthSuffix.writeUIntBE(messageBuffer.length, 0, 4);

  let messageComponents = [magic, lengthSuffix, messageBuffer];

  let fullMessage = Buffer.concat(messageComponents);

  return {
    unpacked: packets,
    packed: fullMessage,
    components: messageToBuffers(fullMessage)
  };
}

function checkPacketSignature(oneSignedPacket) {

  let verificationKey = oneSignedPacket.packet.fromKey.key;

  let signature = oneSignedPacket.signature.signature.toString('base64');

  let packet = PB.Packet.encode(oneSignedPacket.packet);
  let pubkey = new bch.PublicKey(verificationKey);
  let address = pubkey.toAddress().toString();
  let message = packet.finish().toString('base64');
  let result = false;
  try {
    result = new BchMessage(message, 'base64').verify(address, signature);
  }
  catch(someError) {
    console.log('Error checking signature:', someError);
  }

  return result;

}

// {
//   reason: < enum string citing reason for blame accusation >,
//   accused: < verification key in hex format of player who's being accused >,
//   invalid: < an array of protobuff packets that provide evidence of fault >,
//   hash: < hash provided by accused which differs from our own >,
//   keypair: {
//     key: < private key >,
//     public: < public key >
//   }
// }
//
//  Possible Ban Reasons:
//
//     INSUFFICIENTFUNDS = 0
//     DOUBLESPEND = 1
//     EQUIVOCATIONFAILURE = 2
//     SHUFFLEFAILURE = 3
//     SHUFFLEANDEQUIVOCATIONFAILURE = 4
//     INVALIDSIGNATURE = 5
//     MISSINGOUTPUT = 6
//     LIAR = 7
//     INVALIDFORMAT = 8

function blameMessage(options, mySessionId, myPlayerNumber, myVerificationPublicKey, myVerificationPrivateKey) {
  if (_.isObject(myVerificationPublicKey) && typeof myVerificationPublicKey.toString){
    myVerificationPublicKey = myVerificationPublicKey.toString();
  }
  if (_.isObject(myVerificationPrivateKey) && typeof myVerificationPrivateKey.toString){
    myVerificationPrivateKey = myVerificationPrivateKey.toString();
  }

  let blameMessage = _.reduce(_.keys(options), function(msg, oneOptionName) {

    switch (oneOptionName) {
      case 'reason':
        msg.packet.message.blame.reason = PB.Reason.values[options.reason ? options.reason.toUpperCase() : 'NONE'];
      break;
      case 'accused':
        msg.packet.message.blame.accused = PB.VerificationKey.create({
          key: options.accused
        });
      break;
      case 'invalid':
        msg.packet.message.blame.invalue = PB.Invalid.create({ invalid: invalidPackets });
      break;
      case 'hash':
        msg.packet.message.hash = PB.Hash.create({ hash: options.hash });
      break;
      case 'keypair':
        msg.packet.message.blame.key = PB.DecryptionKey.create({
          key: options.keypair.key,
          public: options.keypair.public
        });
      break;
      // case '':
      //   msg.packet.message.
      // break;
      default:
      break;
    };

    return msg;

  }, PB.Signed.create({
    packet: PB.Packet.create({
      session: mySessionId,
      number: myPlayerNumber,
      fromKey: PB.VerificationKey.create({
        key: myVerificationPublicKey
      }),
      message: PB.Message.create({
        blame: PB.Blame.create({
        })
      }),
      phase: PB.Phase.values['BLAME']
    })
  }));

  let msg = PB.Packet.encode(blameMessage.packet).finish().toString('base64');

  blameMessage.signature = PB.Signature.create({
    signature: new BchMessage(msg, 'base64').sign( bch.PrivateKey(myVerificationPrivateKey) )
  });

  console.log('Compiled blame message:', blameMessage)

  return packMessage(blameMessage);

}

module.exports = {
  PB: PB,
  broadcastSignatureAndUtxo: broadcastSignatureAndUtxo,
  broadcastEquivCheck: broadcastEquivCheck,
  broadcastFinalOutputAddresses: broadcastFinalOutputAddresses,
  forwardEncryptedOutputs: forwardEncryptedOutputs,
  messageToBuffers: messageToBuffers,
  decodeAndClassify: decodeAndClassify,
  registration: registration,
  broadcastTransactionInput: broadcastTransactionInput,
  changeAddressAnnounce: changeAddressAnnounce,
  packMessage: packMessage,
  blameMessage: blameMessage,
  checkPacketSignature: checkPacketSignature
};
