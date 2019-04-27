const EventEmitter = require('events').EventEmitter;

const _ = require('lodash');

const CommChannel = require('./CommChannel.js');

const cryptoUtils = require('./cryptoUtils.js');
const coinUtils = require('./coinUtils.js');
const magic = Buffer.from('42bcc32669467873', 'hex');
const bch = require('bitcoincashjs-fork');

// An async-await compatible timeout function
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

class ShuffleRound extends EventEmitter {
  constructor(clientOptions) {
    super();

    // Persist client options 
    for (let oneOption in clientOptions) {
      this[oneOption] = clientOptions[oneOption];
    }

    this.done = false;

    this.phase = '';

    this.util = {
      // Tools for encryption and message sign/verify
      crypto: cryptoUtils,
      // Tools that make REST calls for blockchain data
      coin: coinUtils
    };

    // Public and private key pair destroyed at the end
    // of a shuffle round.  It's only purpose is to sign
    // and verify protocol messages to ensure the players
    // aren't being cheated/attacked by the server or each
    // other.
    this.ephemeralKeypair = this.util.crypto.generateKeypair();

    // A public and private keypair destroyed at the end of
    // a shuffle round.  It is used to encrypt and decrypt
    // message fields during the shuffle round so they are
    // kept private from the server and the other players
    // in the round. 
    this.encryptionKeypair = this.util.crypto.generateKeypair();

    this.hooks = this.hooks || {};

    // Our soon-to-be newly shuffled coin
    if (!_.isFunction(this.hooks.shuffled)) {
      console.log(`A valid shuffle address generation hook was not provided!`);
      throw new Error('BAD_SHUFFLE_FN');
    };

    this.shuffled = this.hooks.shuffled();

    // Make sure either a change generation function or
    // change keypair object was provided. Use the keypair
    // if we got both.
    if (!_.isFunction(this.hooks.change)) {
      console.log(`A valid change generation hook was not provided!`);
      throw new Error('BAD_CHANGE_FN');
    };

    this.change = this.hooks.change();

    // This is where we keep our representation of
    // all the shufflers in the round (including us)
    this.players = [];

    // Once we reach the "shuffle" phase, this
    // array will house the addresses that each
    // players shuffled coins will be sent to
    this.outputAddresses = [];

    // Used to store the partially signed transaction after it
    // is generated but before it is broadcast to the network
    this.shuffleTx = {
      isBuilding: false,
      // We will add each signature and input data
      // to this collection as it is received
      // during the verification and submission phase.
      signatures: []
    };

    // Has the round finished?
    this.roundComplete = false;

    // Was the shuffle successful?
    this.success = false;

    // This object will be extended with error data in the event
    // that the round ends unexpectedly for any reason. This
    // includes a protocol error on behalf of any player in the
    // round (ourselves included) as well as if an exception is
    // thrown in this library.
    this.roundError = {
      // shortCode: 'BAD_SIG',
      // errorObject: [ Error instance containing a stacktrace ],
      // isProtocolError: true,
      // isException: false,
      // accusedPlayer: [ Object containing player data ]
    };

    // Set up a new communication channel for the round
    this.comms = new CommChannel({
      serverUri: this.serverUri
    }, this);

    this.comms.on('serverMessage', async (someServerMessage) => {

      try {
        await this.actOnMessage(someServerMessage);
      }
      catch(nope) {
        console.log('Failed to act right in response to server message:', nope);
        this.writeDebugFile();
      }

    });

    this.comms.on('protocolViolation', this.assignBlame.bind(this));

    this.comms.on('connectionError', this.handleCommsError.bind(this));

    this.comms.on('disconnected', (commsDisconnectMessage) => {

      console.log('Our connection to the cashshuffle server is REKT!');

      if (this.roundComplete) {
        console.log('The shuffle Round has completed');
      }
      else {
        this.success = false;
        this.roundComplete = true;

        _.extend(this.roundError, {
          shortCode: 'COMMS_DISCONNECT',
          errorObject: new Error(commsDisconnectMessage),
          isProtocolError: false,
          isException: false
        });

        this.endShuffleRound();
      }

    });

    this.comms.on('connected', (socket) => {

      // Update our round phase
      this.phase = 'registration';

      try {
        this.comms.sendMessage('registration', this.protocolVersion, this.poolAmount, this.ephemeralKeypair.publicKey);
      }
      catch(nope) {
        console.log('Couldnt send registration message:', nope.message);
      }

    });

    this.ready().catch((nope) => {
      console.log('ERROR:', nope);
    }).then(() => {
    });

    return this;
  }

  handleCommsError(someError) {
    console.log('Something has gone wrong with our communication channel:', someError.message);
    this.roundError = {
      shortCode: 'COMS_ERR',
      errorObject: someError,
      isProtocolError: false,
      isException: true
    };
    this.endShuffleRound();
  }

  async ready() {

    this.emit('debug', { message:'beginning-round' });

    // Setup server connection
    try {
      await this.comms.connect();
    }
    catch(nope) {
      console.log('Failure!', nope);
      throw nope;
    }

  }

  // Process incoming websocket events which contain
  // the prototype buffer encoded server messages.
  async actOnMessage(jsonMessage) {

    let messageType = jsonMessage.pruned.message && jsonMessage.pruned.messageType;

    if (!messageType) {
      throw new Error('BAD_MESSAGE_PARSING');
    }

    let message = jsonMessage.pruned.message;

    let newPhaseName;

    // console.log('Attempting to act on', messageType, 'message\n\n');

    switch (messageType) {
      // The server has informed us of the number
      // of player currently in the pool.  This
      // fires every time a player joins or leaves.
      // We always get one along with out server
      // greeting.
      case 'playerCount':
        this.numberOfPlayers = Number(message['number']);
      break;

      // The server has accepted our pool registration
      // message and replied with our player number and
      // a session id to identify us within this pool
      // and round
      case 'serverGreeting':

        this.myPlayerNumber = Number(message['number']);
        this.session = message['session'];

      break;

      // This is a message sent to all players to
      // inform them that it's now time to share
      // their change address as well as their
      // second ephemeral public key ( later used
      // to decrypt the encrypted output addresses )
      case 'announcementPhase':

        newPhaseName = _.isString(message['phase']) ? message['phase'].toLowerCase() : undefined;

        if (newPhaseName && newPhaseName === 'announcement') {

          this.phase = 'announcement';
          this.numberOfPlayers = Number(message['number']);

          try {
            this.broadcastTransactionInput();
          }
          catch(nope) {
            console.log('Error broadcasting broadcastTransactionInput:', nope);
          }

        }

        else {
          console.log('Problem with server phase message');
          if ( _.get(jsonMessage, 'packets[0].packet.fromKey.key') ) {
            this.assignBlame({
              reason: 'INVALIDFORMAT',
              accused: _.get(jsonMessage, 'packets[0].packet.fromKey.key')
            });
          }
        }

      break;
      case 'incomingVerificationKeys':

        try {
          await this.addPlayerToRound(message);
        }
        catch(nope) {
          console.log('Error broadcasting broadcastTransactionInput:', nope);
        }

        // If we've received the message from all players (including us)
        // containing their `verificationKey` and the coin they wish to
        // shuffle, send the next protocol message if we are player one.
        if (this.myPlayerNumber === _.get(_.minBy(this.players, 'playerNumber'), 'playerNumber')) {
          try {
            await this.announceChangeAddress();
          }
          catch(nope) {
            console.log('Error broadcasting changeAddress:', nope);
            this.endShuffleRound();
          }

        }
      break;
      case 'incomingChangeAddress':

        // If we are player one, we will have already sent this message.
        if (! this.comms.outbox.sent['changeAddressAnnounce']) {
          await this.announceChangeAddress();
        }

        // Update this player with their change address
        _.extend( this.players[_.findIndex(this.players, { session: message['session'] } )] , {
          encryptionPubKey: message['message']['key']['key'],
          change: {
            legacyAddress: message['message']['address']['address']
          }
        });

        // If we are player 1, go ahead and send the first encrypted
        // unicast message containing the Bitcoin address that will
        // house our shuffled output. This function will return without
        // doing anything unless all players
        if (_.get(_.minBy(this.players, 'playerNumber'), 'playerNumber') === this.myPlayerNumber) {

          this.phase = 'shuffle';

          try {
            await this.forwardEncryptedShuffleTxOutputs(undefined, undefined);
          }
          catch(nope) {
            console.log('Error broadcasting changeAddress:', nope);
            this.endShuffleRound();
          }

        }

      break;
      case 'incomingEncryptedOutputs':

        newPhaseName = _.isString(message['phase']) ? message['phase'].toLowerCase() : undefined;

        // Grab the sender of this message by using the verificationKey used
        // to sign this protobuff message.  The signature has already been
        // verified successfully but we're not sure yet if the sender is lying
        // about their player number.  This check will be performed in the the
        // `forwardEncryptedShuffleTxOutputs` function.
        let sentBy = _.find(this.players, {
          verificationKey: _.get(jsonMessage, 'packets[0].packet.fromKey.key')
        });

        if ( this.phase === 'announcement' && newPhaseName === 'shuffle') {

          this.phase = 'shuffle';

          this.forwardEncryptedShuffleTxOutputs(jsonMessage.packets, sentBy);

        }

      break;
      case 'finalTransactionOutputs':

        // console.log('got final transaction outputs!');
        newPhaseName = _.isString(message['phase']) ? message['phase'].toLowerCase() : undefined;

        this.phase = newPhaseName;

        this.checkFinalOutputsAndDoEquivCheck(jsonMessage.packets);

      break;
      case 'incomingEquivCheck':

        try {
          await this.processEquivCheckMessage(message);
        }
        catch(nope) {
          console.log('Error processing incoming equivCheck:', nope);
        }

      break;
      case 'blame':
        this.handleBlameMessage(message);
      break;
      case 'incomingInputAndSig':

        try {
          await this.verifyAndSubmit(message);
        }
        catch(nope) {
          console.log('Error processing incoming output and signature:', nope);
        }

      break;
      // case '':
      // break;
      default:
      break;
    }

    // console.log('Finished acting on', messageType, 'message\n\n');

  }

  // Hand a websockets connection error.
  processWsError(someError) {
    console.log('Oh goodness, something is amiss!', someError);
  }

  /*                          
   *                Begin Coinshuffle Protocol Methods
   *
   *
   *                                                                                    */

  // This function reveals the coin our client wishes to
  // shuffle as well as our verificationKey.  Although we
  // revealed our verificationKey in our server registration
  // message, that message isn't relayed to our peers.  This
  // is the first message where our peers see the vk.
  broadcastTransactionInput() {

    if (this.comms.outbox.sent['broadcastTransactionInput']) {
      return;
    }

    // console.log('Revealing our verificationKey and coin to our peers!');

    let inputsObject = {};
    inputsObject[this.coin.publicKey.toString('hex')] = [this.coin.txid+':'+this.coin.vout];

    try {
      this.comms.sendMessage('broadcastTransactionInput', inputsObject, this.session, this.myPlayerNumber, this.ephemeralKeypair.publicKey);
    }
    catch(nope) {
      console.log('Couldnt send broadcastTransactionInput message:', nope.message);
      return this.endShuffleRound();
    }

    return;
  }


  /*

      This function is called in response to us receiving a new message from either ourselves
      or another player that announces which coin they will be shuffling.  We should
      receive one of these messages for each player in the round (including ourselves). The
      messages are unicast ( no toKey field ).  Note, it's also here where we record each
      player's verificationKey that the `CommChannel` class uses to verify the signature
      on all future messages.

      In this function we do all of the following:

        - Check that the coin exists on the blockchain.
        - Check that the coin value is appropriate for the round value we are in.
        - Add the player to our internal state data

  */
async addPlayerToRound(message) {

    let playerCoin = {
      publicKey: _.keys(message['message']['inputs'])[0]
    };

    let utxoInfo = _.values(message['message']['inputs'])[0]['coins'][0].split(':');

    playerCoin.txid = utxoInfo[0];
    playerCoin.vout = Number(utxoInfo[1]);

    let playerToAdd = {
      session: message['session'],
      playerNumber: Number(message['number']),
      isMe: message['session'] === this.session ? true : false,
      verificationKey: message['fromKey']['key'],
      coin: playerCoin
    };

    if (playerToAdd.isMe) {
      _.extend(playerToAdd.coin, this.coin);
    }

    this.players.push(playerToAdd);

    // console.log('Added player', playerToAdd);

    // We've already added the player to our pool but we
    // still need to verify the data they sent us.
    let coinDetails;
    try {
      coinDetails = await this.util.coin.getCoinDetails(playerCoin.txid, playerCoin.vout);
    }
    catch(nope) {
      console.log('Cannot get coin details', nope);
      this.assignBlame({
        reason: 'INSUFFICIENTFUNDS',
        accused: playerToAdd.verificationKey
      });
    }

    // Check that the coin is there and big enough
    // before adding the player 
    if (!coinDetails.amountSatoshis || this.shuffleFee + this.poolAmount > coinDetails.amountSatoshis) {
      console.log('Insufficient funds for player', coinDetails);
      this.assignBlame({
        reason: 'INSUFFICIENTFUNDS',
        accused: playerToAdd.verificationKey
      });
      return;
    }

    let grabPlayer = _.find(this.players, { session: playerToAdd.session });

    // If it's our message, add our coin object to 
    // the player and only update the fiscal properties
    if (playerToAdd.isMe) {
      _.extend(grabPlayer.coin, {
        amount: coinDetails.amount,
        amountSatoshis: coinDetails.amountSatoshis,
        confirmations: coinDetails.confirmations,
        spent: coinDetails.spent
      });
    }
    else {
      _.extend(grabPlayer.coin, coinDetails);
    }

    // console.log(`Player ${grabPlayer.playerNumber} updated`);

    return;

  }

  // Here we announce our change address as well as the public key
  // that other players should use to encrypt messages meant for
  // our eyes only.  Primarily, they will use it when encrypting
  // the transaction output addresses so we can decrypt them, add
  // our own, and re-encrypt all of them for the next player to 
  // do the same.
  //
  // Encrypting these output address keeps the server from being
  // able to keep a record of which coin belongs to which player.
  announceChangeAddress() {

    // This function fires many times but we should only announce
    // our change address once.  If we've already done this, just
    // return.
    if (this.comms.outbox.sent['changeAddressAnnounce'] || this.players.length < this.numberOfPlayers) {
      return;
    }

    this.comms.sendMessage('changeAddressAnnounce', this.session, this.myPlayerNumber,
      this.change.legacyAddress, this.encryptionKeypair.publicKeyHex, this.phase,
      this.ephemeralKeypair.publicKey, this.ephemeralKeypair.privateKey
    );

  }



  /*

   This function implements processing of messages on Shuffling Phase.
   It does the following:
  
    - Accepts the encrypted output addresses sent to us in the first message of the "shuffle" phase.
      There should be as few as zero and at most all-but-one address(es) in legacy format. They are
      encrypted to our public `encryptionKey` that we shared along with our change address in the
      previous step.

    - The remaining behavior in this function varies depending on if we are are the last player.
      In both cases though, we will first do all of the following:

        1. Make sure this message came from the previous player.
        2. Strip off the top layer of encryption from all strings.
        3. Encrypt and add our own output address that will soon contain our shuffled coin.
        4. Shuffle the entire set of addresses well.  If we are the last player, we may choose not to.
        5. Check that each string is unique.  If not, assign blame and end the round.
  
    - If we are the last player as determined by the highest `number` returned by the server in
      response to our our registration message, then we will signal the end of the shuffle stage
      by broadcasting the complete set of shuffled addresses in decrypted form to every player as
      a regular multicast message.
  
    - If we are not the last player, we encrypt and add our own addresses.  We must add one layer of
      encryption to our address for every subsequent player in the round.  For example, if we are player 3
      in a 10 player round, we must add 7 layers of encryption, starting with player 7 then working our way
      forward through player 4.  Then we send all of them to player 4 as a signed multi-packet unicast message.
      Unicast messages are those that include toKey field which the server relays only the them.


    - Note, if we are player 1, this function has been called without any parameters so there will be nothing for
      us to decrypt and our message will be the first message of the shuffle phase.  Before we send it though, we
      need to make everyone has sent us their decryption keys.  If they haven't, just return without doing anything.
      This function will be called again with each new key received.


  */
  forwardEncryptedShuffleTxOutputs(arrayOfPacketObjects, sender) {

    let me = _.find(this.players, { isMe: true });

    let orderedPlayers = _.orderBy(this.players, ['playerNumber'], ['asc']);

    let firstPlayer = _.minBy(orderedPlayers, 'playerNumber');
    let lastPlayer = _.maxBy(orderedPlayers, 'playerNumber');
    let nextPlayer = orderedPlayers[ _.findIndex(orderedPlayers, { isMe: true })+1 ];
    let previousPlayer = orderedPlayers[ _.findIndex(orderedPlayers, { isMe: true })-1 ];

    // Check that we have received all a decryption key from all players
    // and that they are all unique.  I don't think uniqueness is a protocol
    // requirement but it probably should be.
    if ( _.uniq( _.compact( _.map(orderedPlayers, 'encryptionPubKey') ) ).length !== this.players.length ) {
      // console.log('Waiting for the remaining encryption keys');
      return;
    }

    let stringsForNextPlayer = [];

    if (me.playerNumber !== firstPlayer.playerNumber) {

      // Make sure the player who sent us this message is who it should be
      if (sender.playerNumber !== previousPlayer.playerNumber) {
        console.log(`Player ${sender.playerNumber} is not player ${previousPlayer.playerNumber} despite saying so`);
        this.assignBlame({
          reason: 'LIAR',
          accused: sender.verificationKey
        });

        return;
      }

      let decryptedStrings = _.reduce(arrayOfPacketObjects, (results, onePacket) => {
        let decryptionResults;
        try {
          decryptionResults = this.util.crypto.decrypt( _.get(onePacket, 'packet.message.str'), this.encryptionKeypair.privateKeyHex);
          results.strings.push( decryptionResults.toString('utf-8') )
        }
        catch(nope) {
          console.log('Cannot decrypt');
          results.errors.push({
            packet: onePlayer,
            error: nope
          });
        }

        return results;
      }, {
        strings: [],
        errors: []
      });

      // Blame our sender if the ciphertext cannot be decrypted.  It may or
      // may not be their fault but ... someone has to be the fall guy.
      if (decryptedStrings.errors.length) {

        this.assignBlame({
          reason: 'INVALIDFORMAT',
          accused: sender.verificationKey
        });

      }

      _.each(decryptedStrings.strings, (oneThing) => { stringsForNextPlayer.push(oneThing); });

    }

    // Add our output address after first encrypting it with the
    // public keys of all subsequent players in the round except.
    let ourEncryptedOutputAddress = _.reduceRight(orderedPlayers, (encryptedAddressInfo, onePlayer) => {
      if (nextPlayer && onePlayer.playerNumber >= nextPlayer.playerNumber) {
        try {
          encryptedAddressInfo.string = this.util.crypto.encrypt(encryptedAddressInfo.string, onePlayer.encryptionPubKey);
        }
        catch(nope) {
          console.log(`Cannot encrypt address for encryptionPubKey ${onePlayer.encryptionPubKey} because ${nope.message}`);
          encryptedAddressInfo.errors.push({
            player: onePlayer,
            error: nope
          });
        }
      }
      return encryptedAddressInfo;
    }, {
      errors: [],
      string: this.shuffled.legacyAddress
    });

    if (ourEncryptedOutputAddress.errors.length) {
      this.assignBlame({
        reason: 'INVALIDFORMAT',
        accused: sender.verificationKey
      });
    }

    stringsForNextPlayer.push(ourEncryptedOutputAddress.string);

    // Do a uniqueness check on the output addresses / ciphertexts.
    if (_.compact(_.uniq(stringsForNextPlayer)).length !== stringsForNextPlayer.length) {
      this.assignBlame({
        reason: 'MISSINGOUTPUT',
        accused: sender.verificationKey
      });
    }

    const shuffleArray = function(someArray, num) {
      return ( num > 0 ? shuffleArray( _.shuffle(someArray), num-1) : _.shuffle(someArray) );
    };

    // If we are the last player
    if (me.playerNumber === lastPlayer.playerNumber) {

      console.log(`\n\nBroadcasting final shuffled output addresses ${stringsForNextPlayer}!\n\n`);

      this.comms.sendMessage('broadcastFinalOutputAddresses',
        this.session, me.playerNumber, shuffleArray(stringsForNextPlayer, 100),
        'broadcast', this.ephemeralKeypair.publicKey, this.ephemeralKeypair.privateKey
      );

    }

    else {

      // console.log('Sending encrypted outputs', stringsForNextPlayer, 'to player', nextPlayer.playerNumber, '(', nextPlayer.verificationKey, ')');

      this.comms.sendMessage('forwardEncryptedOutputs',
        this.session, me.playerNumber, shuffleArray(stringsForNextPlayer, 100),
        this.phase, nextPlayer.verificationKey, this.ephemeralKeypair.publicKey,
        this.ephemeralKeypair.privateKey
      );

    }

    return;

  }


  /*

    This function performs processing of the "broadcast" phase message sent by the final player
    in the round.  This message announces the final set of shuffled output addresses.
    This function does all of the following:

      - TODO: Check that the message was actually sent by the last player in the round.
      - Ensure our address is in list of output addresses. If not, blame and exit.
      - Broadcast our own "equivocation check" message.
      - Compute hash of outputs string and broadcast it.

  */
  checkFinalOutputsAndDoEquivCheck(signedPackets) {
    let me = _.find(this.players, { isMe: true });

    let finalOutputAddresses = _.map(signedPackets, 'packet.message.str')

    // Make sure our address was included.  If not, blame!
    if (finalOutputAddresses.indexOf(this.shuffled.legacyAddress) < 0) {
      console.log('Our address isnt in the final outputs!');
      this.assignBlame({
        reason: 'MISSINGOUTPUT',
        accused: _.get(messageObject, _.get(signedPackets[0], 'packet.fromKey.key'))
      });
    }

    console.log('We got the final output addressess and ours was included!', finalOutputAddresses);

    // Attach the entire array of ordered output addresses to our
    // players.  Although we don't know which address belongs to which
    // player ( they've been shuffled by everyone ), the order becomes
    // important later because it effects the transaction output order
    // which has implications for it's signature.
    for (let n = this.players.length; n >= 0; n--) {
      _.extend(this.players[ n ], {
        finalOutputAddresses: finalOutputAddresses
      });
    }

    this.equivHashPlaintext = '[\'' +
      finalOutputAddresses.join('\', \'') +
      '\'][\'' +
      _.map(_.orderBy(this.players, 'playerNumber'), 'encryptionPubKey').join('\', \'') +
    '\']';

    this.equivHash = bch.crypto.Hash.sha256sha256(Buffer.from(this.equivHashPlaintext, 'utf-8')).toString('base64');

    console.log('\n\nHashing\n', this.equivHashPlaintext, '\n\nGives Us\n', this.equivHash, '\n\n');

    // Advance to the next phase
    this.phase = 'EQUIVOCATION_CHECK';

    // Now broadcast the results of our "equivocation check"
    this.comms.sendMessage('broadcastEquivCheck',
      this.session, me.playerNumber, this.equivHash,
      this.phase, this.ephemeralKeypair.publicKey, this.ephemeralKeypair.privateKey
    );

  }

  //  This function implements processing of messages on Equivocation Check phase(phase # 4).
  //  It does the following:
  //
  //  - Verify if hashes from all players are the same. If it is not goes to the blame phase.
  //
  //  - If hashes are the same it sets the next phase as verification and submission phase.
  //
  async processEquivCheckMessage(prunedMessage) {

    let me = _.find(this.players, { isMe: true });
    let firstPlayer = _.minBy(this.players, 'playerNumber');
    let lastPlayer = _.maxBy(this.players, 'playerNumber');

    // Add the hash provided by the player to that player's state data
    let sender = _.extend( this.players[_.findIndex(this.players, { session: prunedMessage['session'] } )] , {
      equivCheck: _.get(prunedMessage, 'message.hash.hash')
    });

    console.log('Got a processEquivCheck message from', sender.verificationKey, 'with hash', sender.equivCheck);

    let allHashes = _.compact(_.map(this.players, 'equivCheck'));

    if ( allHashes.length === this.players.length) {

      // Are all the hashes the same and do they equal ours?
      if (_.uniq(allHashes).length === 1 && _.uniq(allHashes)[0] === this.equivHash) {
        console.log('Everyone passes the EQUIVOCATION_CHECK!');
        this.phase = 'VERIFICATION_AND_SUBMISSION';

        if (me.playerNumber === firstPlayer.playerNumber) {
          try {
            await this.verifyAndSubmit();
          }
          catch(nope) {
            console.log('Error processing incoming output and signature:', nope);
          }
        }

      }
      else {
        console.log('Someone failed the equivCheck!');

        for (let onePlayer of round.players) {
          if (onePlayer.equivCheck !== me.equivCheck) {
            this.assignBlame({
              reason: 'EQUIVOCATIONFAILURE',
              accused: sender.verificationKey,
              hash: onePlayer.equivCheck
            }, true);
          }
        }
      }

    }
    else {
      // console.log('Waiting for more equivCheck messages');
    }


  }

  /*

   This function handles messages for the final phase of the protocol (phase # 5).
   It does the following:
  
    - Creates an unsigned transaction that adheres to the *CashShuffle spec ( input order and amounts, etc ).

    - Partially sign the transaction.  Sign our input then broadcast it's signature to the other players.
  
    - Check if we've received the input signature all the other players.
  
    - Verify the input signature's of all players. If there is a wrong signature go to the blame phase.
  
    - If everything is good, use the signatures to finish signing the transaction.

    - Broadcast the transaction to the network.
  
    - Set the done flag and cleanup the round

  */
  async verifyAndSubmit(prunedMessage) {

    let orderedPlayers = _.orderBy(this.players, ['playerNumber'], ['asc']);
    let firstPlayer = _.minBy(orderedPlayers, 'playerNumber');
    let lastPlayer = _.maxBy(orderedPlayers, 'playerNumber');
    let me = _.find(this.players, { isMe: true });

    // If we got a signature message before we've finished building
    // the partially signed transaction, wait up to 15 seconds or until
    // the transaction is done building before letting processing
    // this message.  Otherwise, chaos reigns.
    if (this.shuffleTx.isBuilding) {
      let waitUntilThisTime = new Date().getTime()+(1000*15);

      while (this.shuffleTx.isBuilding) {
        let timeNow = new Date().getTime();
        if ( timeNow > waitUntilThisTime || !this.shuffleTx.isBuilding) {
          this.shuffleTx.isBuilding = false;
        }
        else {
          await delay(500);
        }
      }
    }

    // If we haven't built the shuffle transaction and
    // broadcast our signature, do so now.
    if (! this.comms.outbox.sent['broadcastSignatureAndUtxo']) {

      // Set the isBuilding flag so incoming messages don't trigger
      // multiple transaction build attempts and multiple signature
      // broadcasts.  It sometimes takes a few seconds to build the
      // partially signed transactions because we also hit a REST
      // endpoint to validate user's have sufficient funds.
      this.shuffleTx.isBuilding = true;

      let shuffleTransaction;
      try {
        shuffleTransaction = await this.util.coin.buildShuffleTransaction({
          players: this.players,
          feeSatoshis: this.shuffleFee
        });
      }
      catch(nope) {
        console.log('Problem building shuffle transaction:', nope);
        this.writeDebugFile();
      }

      _.extend(this.shuffleTx, {
        serialized: shuffleTransaction.serialized,
        tx: shuffleTransaction.tx,
        inputs: shuffleTransaction.inputs,
        outputs: shuffleTransaction.outputs
      });

      // Broadcast our transaction signature.  If the other players
      // are able to apply it to their copy of the transaction then
      // the shuffleRound is complete.

      this.comms.sendMessage('broadcastSignatureAndUtxo',
        this.session, me.playerNumber, me.coin.txid+':'+me.coin.vout,
        shuffleTransaction.signatureBase64, this.phase, this.ephemeralKeypair.publicKey,
        this.ephemeralKeypair.privateKey
      );

      // Turn off the isBuilding sign so any queued up signature
      // checks may now occur.
      this.shuffleTx.isBuilding = false;
    }

    // The CashShuffle protocol dictates that the first player in the
    // round is responsible for first broadcasting their transaction
    // signature.  So if we ARE the first player, we call this function
    // without any parameters after we've received and verified the hashes.
    // We will exit now after sending the protocol message and this function
    // will be immediately called again (this time with parameters) as the
    // server sends us our own signature message. 
    if (firstPlayer.playerNumber === me.playerNumber && !prunedMessage) {
      return;
    }

    let utxo = _.get(prunedMessage, 'message.signatures[0].utxo');

    let newSigData = {
      prevTxId: utxo.split(':')[0],
      vout: Number(utxo.split(':')[1]),
      signature: Buffer.from(_.get(prunedMessage, 'message.signatures[0].signature.signature'), 'base64').toString('utf-8')
    };

    this.shuffleTx.signatures.push(newSigData);

    let signer = _.find(this.players, (onePlayer) => {
      return onePlayer.coin.txid === newSigData.prevTxId && Number(onePlayer.coin.vout) === newSigData.vout;
    });

    if (!signer) {
      this.assignBlame({
        reason: 'INVALIDSIGNATURE',
        accused: _.get(prunedMessage, 'fromKey.key')
      });
      return;
    }

    console.log(`Got a shuffle transaction signature for coin ${utxo}`);

    // Verify that the signature we've been given is valid for the shuffle
    // transaction input they've stated.  If so, we will add that signature
    // to our transaction.  If not, we will abort and blame the sender.
    // Note, the function returns the data necessary to add the signature.
    // That data takes the form below.
    // 
    // {
    //   success: true,
    //   inputIndex: signatureObject.inputIndex,
    //   signature: signatureObject
    // };
    let sigVerifyResults;
    try {
      sigVerifyResults = this.util.coin.verifyTransactionSignature(this.shuffleTx.tx, newSigData, _.get(signer, 'coin.publicKey'));
    }
    catch(nope) {
      console.log('Error when trying to validate signature', nope);
      this.assignBlame({
        reason: 'INVALIDSIGNATURE',
        accused: _.get(prunedMessage, 'fromKey.key')
      });
      return;
    }

    if (sigVerifyResults && sigVerifyResults.success) {
      console.log(`\n\nShuffle transaction signature for ${utxo} checks out!\n\n`);

      // If it was us that sent the message, we don't need to apply
      // the signature.  Our signature was applied during the creation
      // of the shuffle transaction.  We only need to apply the other
      // player's signatures.
      if (!signer.isMe) {

        // console.log(`Applying signature to input${sigVerifyResults.inputIndex}!`);

        let signedInput;
        try {
          signedInput = this.shuffleTx.tx.inputs[sigVerifyResults.inputIndex].addSignature(this.shuffleTx.tx, sigVerifyResults.signature);
        }
        catch(nope) {
          console.log('We failed to apply a signature to our transaction.  Looks like our fault', nope);
          // TODO: throw and cleanup
        }

      } 

    }
    else {
      console.log(`Bad signature for coin ${utxo}`);
      this.assignBlame({
        reason: 'INVALIDSIGNATURE',
        accused: _.get(prunedMessage, 'fromKey.key')
      });
    }

    let txIsFullySigned;
    try {
      txIsFullySigned = this.shuffleTx.tx.isFullySigned();
    }
    catch(nope) {
      console.log('Malformed shuffle transaction', nope);
      this.endShuffleRound();
    }

    if (txIsFullySigned && this.shuffleTx.signatures.length === this.numberOfPlayers) {

      console.log(`\n\n\t\tBroadcasting CashShuffle tx ${this.shuffleTx.tx.hash} to the network!\n\n`);

      let submissionResults;
      try {
        submissionResults = await this
          .util
          .coin
          .BITBOX
          .RawTransactions
          .sendRawTransaction(this.shuffleTx.tx.toBuffer('hex').toString('hex'));
      }
      catch(nope) {
        console.log('Error broadcasting transaction to the network:', nope);
        this.endShuffleRound();
        return;
      }

      if (submissionResults) {
        _.extend(this.shuffleTx, {
          results: submissionResults
        });
      }

      let allOutputAddressesUsed = _.map(this.shuffleTx.tx.outputs, (oneOutput) => {
        return oneOutput.script.toAddress().toString();
      });

      // Add a property so the user's wallet logic can
      // quickly tell if this change address can be reused.
      _.extend(this.change, {
        usedInShuffle: allOutputAddressesUsed.indexOf(this.change.legacyAddress) > -1 ? true : false
      });

      this.success = true;
      this.endShuffleRound();
    }
    else {
      // console.log('Waiting on more signatures...');
    }

  }

  endShuffleRound(writeDebugFileAnyway) {
    // console.log(`Shuffle has ended with success ${ this.success }\n`);
    this.roundComplete = true;

    if (!this.success || writeDebugFileAnyway) {
      console.log('writing debug file');
      this.writeDebugFile();
    }

    // Close this round's connection to the server
    this.comms._wsClient.close();
    this.emit('shuffle', this);
    return;
  }

  // When we receive a message from another player
  // accusing someone of violating the protocol.
  handleBlameMessage(messageObject) {
    let keyOfAccused = _.get(messageObject, 'message.blame.accused.key');

    let accused = _.find(this.players, { verificationKey: keyOfAccused });

    if (accused.isMe) {
      console.log('IM THE ONE BEING BLAMED.  HOW RUDE!')
    }
    else {
      console.log('Player', accused.verificationKey, 'is to blame!');
    }

    this.writeDebugFile();

  }

  writeDebugFile() {
    this.comms.writeDebugFile(true);
  }

  // When we conclude that a player has violated the
  // protocol and we need to send out a blame message.
  // 
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
  assignBlame(details, keepAlive) {

    console.log(`Issuing a formal blame message against ${details.accused} for ${details.reason}`);

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
    //

    this.comms.sendMessage('blameMessage', details, this.session, this.myPlayerNumber, this.ephemeralKeypair.publicKey, this.ephemeralKeypair.privateKey);

    if (!keepAlive) {
      this.endShuffleRound();
    }

  }

}

module.exports = ShuffleRound;
