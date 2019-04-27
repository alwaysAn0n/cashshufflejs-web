const EventEmitter = require('events').EventEmitter;

const WebSocket = require('ws');
const serverMessages = require('./serverMessages.js');
const _ = require('lodash');

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

    // This and all communication functionality
    // will be moved to a separate class. The `Round`
    // should only touch messages after they have been
    // Parsed, validated, and classified.
    this._wsClient = new WebSocket(this.serverUri, {
      origin: 'http://localhost'
    });

    // When a message is received from the CashShuffle Server
    this._wsClient.on('message', (someMessageBuffer) => {

      let message = this.msg.decodeAndClassify(someMessageBuffer);

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

      // console.log(`\n\nA New ${message.pruned.messageType} Message has arrived!\n`);
      // console.log('\n\nA New Message has arrived', require('util').inspect(message.pruned, null, 4) ,'\n');

      let packetVerifyResults = {
        success: [],
        fail: []
      };

      let sender;

      if (message.packets[0].packet.fromKey) {
        sender = _.find(this.round.players, { verificationKey: message.packets[0].packet.fromKey.key });
        // console.log('Checking signature for', message.pruned.messageType.toUpperCase(), 'message from' , ( sender ?  sender.session+' ( '+sender.verificationKey+' ) ' : 'player with sessionId '+message.pruned.session ) );
      }

      for (let onePacket of message.packets) {

        if (onePacket.signature) {

          if (!this.msg.checkPacketSignature(onePacket)) {
            packetVerifyResults.fail.push(onePacket);
          }

          else {
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
        console.log('\n\tSignature check failed!\n');

        // This event will be piped right into the
        // `assignBlame` method on the `ShuffleClient`
        // class
        this.emit('protocolViolation', {
          reason: 'INVALIDSIGNATURE',
          accused: _.get(oneSignedPacket,'packet.fromKey.key'),
          invalid: packetVerifyResults.fail
        });
      }

    });

    // When the websockets connection is established with the CashShuffle server
    this._wsClient.on('open', () => {

      this._wsConnected = true;
      // console.log('We are now connected to the cashshuffle server', this.serverUri);

      this.emit('connected', this._wsClient);

    });

    // When the websockets connection is closed for any reason
    this._wsClient.on('close', (details) => {
      if (!this.round.roundComplete) {
        console.log('Socket connection closed:', details);
        this.emit('disconnected', details);
      }
    });

    // Handle websockets errors
    this._wsClient.on('error', (someError) => {
      console.log('THERE WAS A SOCKET ERROR!', someError);
      this.emit('connectionError', someError);
    });

  }

  sendMessage() {

    let messageType = arguments[0];

    let messageParams = [].slice.call(arguments, 1, );

    console.log('\n\nNow sending message:', messageType, '\n\n');

    let packedMessage;
    if (messageType && typeof this.msg[messageType] === 'function') {
      try {
        packedMessage = this.msg[messageType].apply(this, messageParams );
      }
      catch(nope) {
        console.log('Couldnt create', messageType, 'message using params', messageParams, '\n', nope);
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
    require('fs').writeFileSync('_failedShuffle.js', 'module.exports = '+data+';'); 
    process.exit(0);
  }

}

module.exports = CommChannel;