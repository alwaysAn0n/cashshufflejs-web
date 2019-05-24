const EventEmitter = require('events').EventEmitter;
const fs = require('fs');

const WebSocket = require('isomorphic-ws');
const serverMessages = require('./serverMessages.js');
const _ = require('lodash');
const debug = require('debug')('cashshufflejs-web');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

class CommChannel extends EventEmitter {
  constructor(connectionOptions, shuffleRoundInstance) {
    super();

    // Set instance properties
    for (let oneOption in connectionOptions) {
      this[oneOption] = connectionOptions[oneOption];
    }

    this.serverUri = connectionOptions.serverUri;

    if (!this.serverUri) {
      let connectionError = new Error('BAD_SERVER_URI');
      this.emit('connectionError', connectionError );
    }

    // Our Websocket client lives here
    this._wsClient = undefined;

    this.msg = serverMessages;

    this.round = shuffleRoundInstance;

    // Our internal records for sent
    // and received server messages.
    // Used for debugging bad rounds.
    this.outbox = {
      sent : {}
    };
    this.inbox = {};

    return this;

  }

  // Establish websockets connection with shuffle server.
  async connect() {
    this._wsClient = new WebSocket(this.serverUri, typeof window === 'undefined' ? {
      origin: 'http://localhost'
    } : undefined );

    this._wsClient.binaryType = 'arraybuffer';

    // When a message is received from the CashShuffle Server
    this._wsClient.onmessage = (someEvent, a, b, c) => {
if (typeof window !== 'undefined') {window.messages = {};window.messages['balls'+new Date().getTime()] = _.extend(someEvent, {a:a,b:b,c:c})};
      let message = this.msg.decodeAndClassify(someEvent.data);

      let messageSubClass;
      if (message.pruned.messageType === '_unicast') {

        if (this.round.phase.toLowerCase() === 'announcement') {
          messageSubClass = 'incomingEncryptedOutputs';
        }
        else {
          messageSubClass = 'UNKNOWN'
        }

      }

      // Change the message type for unicast messages;
      _.extend(message.pruned, {
        messageType: messageSubClass ? messageSubClass : message.pruned.messageType
      });

      // Add the message to our inbox in case we need it later
      let inboxEntry = {
        messageType: message.pruned.messageType,
        time: new Date().getTime(),
        protobuffMessage: {
          unpacked: message.full,
          components: message.components
        }
      };

      this.inbox[message.pruned.messageType] = this.inbox[message.pruned.messageType] ? _.sortBy(this.inbox[message.pruned.messageType].concat([inboxEntry]), ['time'], ['desc']) : [inboxEntry];

      // debug(`\n\nA New ${message.pruned.messageType} Message has arrived!\n`);
      // debug('\n\nA New Message has arrived', require('util').inspect(message.pruned, null, 4) ,'\n');
      debug('\n\nA New Message has arrived', message.pruned ,'\n');

      let packetVerifyResults = {
        success: [],
        fail: []
      };

      let sender;

      if (message.packets[0].packet.fromKey) {
        sender = _.find(this.round.players, { verificationKey: message.packets[0].packet.fromKey.key });
        debug('Checking signature for', message.pruned.messageType.toUpperCase(), 'message from' , ( sender ?  sender.session+' ( '+sender.verificationKey+' ) ' : 'player with sessionId '+message.pruned.session ) );
      }

      for (let onePacket of message.packets) {

        if (onePacket.signature) {

          if (!this.msg.checkPacketSignature(onePacket)) {
console.log('signature failed on packet', onePacket);
            packetVerifyResults.fail.push(onePacket);
          }

          else {
console.log('signature checks out');
            packetVerifyResults.success.push(onePacket);
          }

        }

        // The signature doesn't need to be verified.
        else {
          packetVerifyResults.success.push(onePacket);
        }
        
      }

      if (!packetVerifyResults.fail.length) {
        this.emit('serverMessage', message);
      }
      else {
        debug('\n\tSignature check failed!\n');

        // This event will be piped right into the
        // `assignBlame` method on the `ShuffleClient`
        // class
        this.emit('protocolViolation', {
          reason: 'INVALIDSIGNATURE',
          // TODO: Make this an array. We should be able to blame more than one player.
          accused: _.get(packetVerifyResults.fail[0],'packet.fromKey.key'),
          invalid: packetVerifyResults.fail
        });
      }

    };

    // When the websockets connection is established with the CashShuffle server
    this._wsClient.onopen = () => {

      this._wsConnected = true;
      // debug('We are now connected to the cashshuffle server', this.serverUri);

      this.emit('connected', this._wsClient);

    };

    // When the websockets connection is closed for any reason
    this._wsClient.onclose = (someEvent) => {

      let details = someEvent.data;
console.log('Socket connection closed:', details);
      if (!this.round.roundComplete) {
        debug('Socket connection closed:', details);
        this.emit('disconnected', details);
      }
    };

    // Handle websockets errors
    this._wsClient.onerror = (someEvent) => {

      let someError = someEvent.data;

      debug('THERE WAS A SOCKET ERROR!', someEvent);
      this.emit('connectionError', someEvent);
    };

  }

  sendMessage() {

    let messageType = arguments[0];

    let messageParams = [].slice.call(arguments, 1, );

    debug('\n\nNow sending message:', messageType, '\n\n');

    let packedMessage;
    if (messageType && typeof this.msg[messageType] === 'function') {
      try {
        packedMessage = this.msg[messageType].apply(this, messageParams );
      }
      catch(nope) {
        debug('Couldnt create', messageType, 'message using params', messageParams, '\n', nope);
        // TODO: Throw exception?
      }
    }
    else {
      // TODO: Should we throw an exception now?
    }

    // Add the message to our outbox in case we need it later
    let outboxEntry = {
      messageType: messageType,
      time: new Date().getTime(),
      protobuffMessage: {
        // packed: packedMessage.packed.toString('base64'),
        unpacked: packedMessage.unpacked.toJSON(),
        components: packedMessage.components
      }
    };

    if (!this.outbox[messageType]) {
      let obj = {};
      obj[messageType] = [];
      _.extend(this.outbox, obj);
    }

    this.outbox.sent[messageType] = true;
    this.outbox[messageType].push(outboxEntry);

    this._wsClient.send(packedMessage.packed);

  }

  writeDebugFile() {

    for (let oneKey in this.inbox) {
      if (_.isArray(this.inbox[oneKey])) {
        this.inbox[oneKey] =  _.sortBy(this.inbox[oneKey], ['time'], ['desc'])
      }
    }
    for (let oneKey in this.outbox) {
      if (_.isArray(this.outbox[oneKey])) {
        this.outbox[oneKey] =  _.sortBy(this.outbox[oneKey], ['time'], ['desc'])
      }
    }

    let writeThisToDisk = {
      phase: this.round.phase,
      coin: this.round.coin,
      ephemeralKeypair: this.round.ephemeralKeypair,
      encryptionKeypair: this.round.encryptionKeypair,
      shuffled: this.round.shuffled,
      change: this.round.change,
      players: this.round.players,
      equivHashPlaintext: this.round.equivHashPlaintext,
      equivHash: this.round.equivHash,
      shuffleTx: {
        signatures: this.round.shuffleTx.signatures,
        hex: this.round.shuffleTx.hex,
        serialized: this.round.shuffleTx.tx ? this.round.shuffleTx.tx.toObject() : {},
        results: this.round.shuffleTx.results
      },
      inbox: this.inbox,
      outbox: this.outbox
    };

    let data = JSON.stringify(writeThisToDisk, null, 2);

    if (typeof fs !== 'undefined' && fs.writeFileSync) {
      fs.writeFileSync('_failedShuffle.js', 'module.exports = '+data+';'); 
      process.exit(0);
    }

  }

}

module.exports = CommChannel;