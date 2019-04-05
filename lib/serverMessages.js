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

      if (serverMessage.packets.length >= 2) {
        console.log(JSON.stringify(serverMessage.packets, null,4));
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
    let matchingMessageType = _.reduce([
      { name: 'playerCount', required: ['number'] },
      { name: 'serverGreeting', required: ['number','session'] },
      { name: 'announcementPhase', required: ['number','phase'] },

      // { name: 'incomingChangeAddress', required: ['number','session','fromKey.key','message.address.address','phase'] },
      // { name: 'unicastShuffle', required: ['number','session','fromKey.key','toKey.key','message.str'] },
      // { name: 'incomingVerificationKeys', required: ['session','fromKey.key','message.inputs'] },
      { name: 'incomingVerificationKeys', required: ['session','fromKey.key','message.inputs'] },

      { name: 'incomingChangeAddress', required: ['session','number','fromKey.key','message.address.address', 'message.key.key', 'phase'] },
      { name: 'unicastShuffle', required: ['number','session','fromKey.key','toKey.key','message.str'] },
      { name: 'blame', required: ['number','session','fromKey.key','message.blame','phase'] }
    ], function(winner, oneObject) {
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
  console.log('Announcing keys with inputs:', inputsObject, session, playerNumber, verificationPublicKey);

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

function changeAddressAnnounce(session, playerNumber, changeAddress, changeAddressPublicKey, phase, verificationPublicKey, verificationPrivateKey) {

  if (_.isObject(changeAddressPublicKey) && typeof changeAddressPublicKey.toString){
    changeAddressPublicKey = changeAddressPublicKey.toString();
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
          key: changeAddressPublicKey
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
function packMessage(somePacket) {
  let packets = PB.Packets.create({ packet: [ somePacket ] });
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

function buildSignedPacket(eck, session, playerNumber, vkFrom, vkTo, phase) {

  let message;
  message = PB.Signed.create({
    packet: PB.Packet.create({

    })
  });
  message.packet.phase = PB.Phase.values[phase.toUpperCase()];
  message.packet.session = session;
  message.packet.playerNumber = playerNumber;
  message.packet.fromKey = PB.VerificationKey.create({
    key: vkFrom
  });
  if (vkTo) {
    message.packet.toKey = PB.VerificationKey.create({
      key: vkTo
    });
  }
  console.log('Encoding Message:',message.packet);
  let msg = PB.Packet.encode(message.packet).finish().toString('base64');
  let signature = BchMessage(msg, 'base64').sign(eck);
  let sig_bytes = Buffer.from(signature, 'base64');
  message.signature = PB.Signature.create({
    signature: sig_bytes
  });

}

module.exports = {
  PB: PB,
  messageToBuffers: messageToBuffers,
  decodeAndClassify: decodeAndClassify,
  registration: registration,
  broadcastTransactionInput: broadcastTransactionInput,
  changeAddressAnnounce: changeAddressAnnounce,
  packMessage: packMessage,
  checkPacketSignature: checkPacketSignature,
  buildSignedPacket: buildSignedPacket
};
