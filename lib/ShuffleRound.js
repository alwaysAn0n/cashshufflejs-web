const EventEmitter = require('events').EventEmitter;

const _ = require('lodash');

const CommChannel = require('./CommChannel.js');

const cryptoUtils = require('./cryptoUtils.js');
const coinUtils = require('./coinUtils.js');
const magic = Buffer.from('42bcc32669467873', 'hex');

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

    // Our soon-to-be newly shuffled coin
    this.shuffled = this.util.crypto.generateKeypair();
    _.extend(this.shuffled, this.util.coin.buildCoinFromPrivateKey(this.shuffled.privateKey) );

    // The change coin from our shuffle transaction
    this.change = this.util.crypto.generateKeypair();
    _.extend(this.change, this.util.coin.buildCoinFromPrivateKey(this.change.privateKey) );

    // This is where we keep our representation of
    // all the shufflers in the round (including us)
    this.players = [];

    // Once we reach the "shuffle" phase, this
    // array will house the addresses that each
    // players shuffled coins will be sent to
    this.outputAddresses = [];

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

    })

    this.comms.on('protocolViolation', this.assignBlame.bind(this));

    this.comms.on('connectionError', this.handleCommsError.bind(this));

    this.comms.on('disconnected', (details) => {

      console.log('Our connection to the cashshuffle server is REKT!');

      if (this.completed) {
        console.log('The shuffle Round has completed');
      }
      else {
        this.writeDebugFile();
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

  handleCommsError(someErrorMessage) {
    console.log('Something has gone wrong with our communication channel:', someErrorMessage);
    this.writeDebugFile();
  }

  async ready() {

    // TODO: Set interval that calls a function
    // which checks for players who've timed out
    // and make sure it's not our action (i.e. we
    // are player therefore we must be the first
    // to broadcast our transactionInput)

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

    console.log('Attempting to act on', messageType, 'message\n\n');

    switch (messageType) {
      // The server has informed us of the number
      // of player currently in the pool.  This
      // fires every time a player joins or leaves.
      // We always get one along with out server
      // greeting.
      case 'playerCount':
        this.numberOfPlayers = message['number'];
      break;

      // The server has accepted our pool registration
      // message and replied with our player number and
      // a session id to identify us within this pool
      // and round
      case 'serverGreeting':
        this.myPlayerNumber = message['number'];
        this.session = message['session'];

        try {
          await this.broadcastTransactionInput();
        }
        catch(nope) {
          console.log('Error broadcasting broadcastTransactionInput:', nope);
        }

      break;

      // This is a message sent to all players to
      // inform them that it's now time to share
      // their second ephemeral public key ( used
      // to decrypt the encrypted output address )
      // as well as the bitcoin address any unshuffled
      // change should be kept.
      case 'announcementPhase':

        newPhaseName = _.isString(message['phase']) ? message['phase'].toLowerCase() : undefined;

        if (newPhaseName && newPhaseName === 'announcement') {

            this.phase = 'announcement';
            this.numberOfPlayers = message['number'];

            try {
              await this.announceChangeAddress();
            }
            catch(nope) {
              console.log('Error broadcasting changeAddress:', nope);
              // TODO: handle error
            }

        }
        // TODO: Assign blame if out of phase
        // or phase name isn't supported in
        // the protocol.
        else {
          console.log('Problem with server phase message');
          this.writeDebugFile();
        }

      break;
      case 'incomingVerificationKeys':

        // TODO: add check against adding players when pool is already full
        this.addPlayerToRound(message);

      break;
      case 'incomingChangeAddress':

          // Update this player with their change address
          _.extend( this.players[_.findIndex(this.players, { session: message['session'] } )] , {
            encryptionPubKey: message['message']['key']['key'],
            change: {
              legacyAddress: message['message']['address']['address']
            }
          });

          // THIS SHOULD ONLY HAPPEN ONCE
          if (! this.comms.outbox.sent['changeAddressAnnounce']) {
            console.log('sending change address!');
            this.announceChangeAddress();
          }

      break;
      case 'incomingEncryptedOutputs':

        // TODO: Make sure this message is in sequence
        // ( from `playerNumber` just before ours ) 
        console.log('We got the encrypted outputs!');

        newPhaseName = _.isString(message['phase']) ? message['phase'].toLowerCase() : undefined;

        if (this.phase === 'announcement' && newPhaseName === 'shuffle') {

          this.phase = 'shuffle';

          this.processEncryptedTransactionOutputs(jsonMessage.packets);

        }

      break;
      case 'finalTransactionOutputs':

        newPhaseName = _.isString(message['phase']) ? message['phase'].toLowerCase() : undefined;

        this.phase = newPhaseName;

        this.checkFinalOutputsAndDoEquivCheck(jsonMessage.packets);

      break;
      case 'incomingEquivCheck':
        this.phase = 'EQUIVOCATION_CHECK';

        console.log('We now must do broadcast an equivocation check!');

        this.writeDebugFile();

      break;
      case 'blame':
        this.handleBlameMessage(message);
      break;
      // case '':
      // break;
      // case '':
      // break;
      default:
      break;
    }

    console.log('Finished acting on', messageType, 'message\n\n');

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
  async broadcastTransactionInput() {

    // If we've already sent this and we've created
    // a player for ourselves ( which means we've
    // the server has relayed our message back to
    // us ) , then ignore this message.  Either a
    // peer has sent it maliciously or the server
    // has malfunctioned.
    if (this.comms.outbox.sent['broadcastTransactionInput']) {
      return;
    }

    console.log('Revealing our verificationKey and coin to our peers!');

    let coinDetails;
    try {
      coinDetails = await this.util.coin.getCoinDetails(this.coin.txid,  this.coin.vout );
    }
    catch(nope) {
      console.log('Couldnt get coin', this.coin.txid, this.coin.vout, ':', nope.message);
      // process.exit();
    }

    // console.log('inputsObject:', inputsObject);

    let inputsObject = {};
    inputsObject[this.coin.publicKey.toString('hex')] = [coinDetails.txid+':'+coinDetails.vout];

    // TODO don't include change address unless change is needed
    
    try {
      this.comms.sendMessage('broadcastTransactionInput', inputsObject, this.session, this.myPlayerNumber, this.ephemeralKeypair.publicKey);
    }
    catch(nope) {
      console.log('Couldnt send broadcastTransactionInput message:', nope.message);
      // TODO: handle error
    }

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

addPlayerToRound(message) {


    let playerCoin = {
      publicKey: _.keys(message['message']['inputs'])[0]
    };

    let utxoInfo = _.values(message['message']['inputs'])[0]['coins'][0].split(':');

    playerCoin.txid = utxoInfo[0];
    playerCoin.vout = utxoInfo[1];

    let playerToAdd = {
      session: message['session'],
      playerNumber: message['number'],
      isMe: message['number'] === this.myPlayerNumber ? true : false,
      verificationKey: message['fromKey']['key'],
      coin: playerCoin
    };

    // TODO: Check that the input address given has
    // a sufficient balance on the blockchain.

    this.players.push(playerToAdd);

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

    let me = _.find(this.players, { isMe: true });

    if (me){
      this.comms.sendMessage('changeAddressAnnounce', this.session, me.playerNumber, this.change.legacyAddress, this.encryptionKeypair.publicKeyHex, this.phase, this.ephemeralKeypair.publicKey, this.ephemeralKeypair.privateKey);
    }

  }



  /*

   This function implements processing of messages on shuffling phase (phase #2).
   It does the following:
  
    - Accepts the encrypted output addresses sent to us in the first message of the "shuffle" phase.
      There should be at least one and at most all-but-one addresses in legacy format. They are
      encrypted to the public key ( this.encryptionKeypair ) that we shared along with our change
      address in the previous step.
      
    - The behavior in this function varies depending on if we are are the last player or not.
      In both cases though, we will first do all of the following:

        1. Make sure this message came from the previous player.
        2. decrypt the output addresses
        3. Add own output address that will contain our shuffled coin
        4. Shuffle the entire set of addresses very well.
        5. Check that each address is unique.  If not, assign blame and end the round.
  
    - If we are the last player as determined by the highest `number` returned by the server in
      response to our our registration message, then we will signal the end of the shuffle stage
      by broadcasting the complete set of shuffled addresses in decrypted form to every player as
      a regular multicast message.
  
    - If we are not the last player, we re-encrypt the shuffled addresses then send them to player
      with the next highest player number as a signed multi-packet unicast message. Unicast
      messages are those that include toKey field which the server relays only the them.

  */
  processEncryptedTransactionOutputs(arrayOfPacketObjects) {

    let outputAddresses = _.reduce(arrayOfPacketObjects, (results, onePacket) => {

      let decryptionResults;
      try {
        decryptionResults = this.util.crypto.decrypt( _.get(onePacket, 'packet.message.str'), this.encryptionKeypair.privateKeyHex);
        results.addresses.push( decryptionResults.toString('utf8') )
      }
      catch(nope) {
        console.log('Cannot decrypt')
        results.errors.push(onePacket);
      }

      return results;
    }, {
      addresses: [],
      errors: []
    });

    if (outputAddresses.addresses.length !== _.uniq(outputAddresses.addresses).length) {
      console.log('The input addresses are not unique!');
      this.writeDebugFile();
    }

    // TODO: Handle blame for bad output addresses

    let me = _.find(this.players, { isMe: true });

    outputAddresses.addresses.push(this.shuffled.legacyAddress);

    // The next player isn't necessarily `me.playerNumber + 1`
    let nextPlayer = _.reduce(this.players , function(bestNextPlayer, onePlayer) {

      if (onePlayer.playerNumber > me.playerNumber) {

        if (!bestNextPlayer) {
          return onePlayer;
        }
        else {
          return (bestNextPlayer.playerNumber > onePlayer.playerNumber ? onePlayer : bestNextPlayer);
        }

      }
      return;

    }, undefined);

    const shuffleArray = function(someArray, num) {
      return ( num > 0 ? shuffleArray( _.shuffle(someArray), num-1) : _.shuffle(someArray) );
    };

    if (nextPlayer) {

      let encryptedOutputAddresses = _.reduce( shuffleArray(outputAddresses.addresses, 100), (encryptionResults, oneLegacyAddress) => {
        try {
          encryptionResults.success.push( this.util.crypto.encrypt(oneLegacyAddress, nextPlayer.encryptionPubKey) );
        }
        catch(nope) {
          console.log('Failed to encrypt address', oneLegacyAddress, 'meant for player', nextPlayer.verificationKey, 'using encryptionPubKey', nextPlayer.encryptionPubKey, 'because:', nope);
          encryptionResults.fail.push({
            address: oneLegacyAddress,
            error: nope
          });
        }
        return encryptionResults;
      }, {
        success: [],
        fail: []
      });

      // TODO: Handle re-encryption failures
      if (encryptedOutputAddresses.fail.length) {
        console.log('We had some problems encrypting the output addresses');

        for (let oneFailure of encryptedOutputAddresses.fail) {
          console.log('\t', oneFailure.address, ':', oneFailure.error.message, '\n');
        }

        return this.writeDebugFile();

      }

      console.log('Sending encryptedOutputAddresses', encryptedOutputAddresses.success, 'to player', nextPlayer.playerNumber, '(', nextPlayer.verificationKey, ')');

      this.comms.sendMessage('forwardEncryptedOutputs',
        this.session, me.playerNumber, encryptedOutputAddresses.success,
        this.phase, nextPlayer.verificationKey, this.ephemeralKeypair.publicKey,
        this.ephemeralKeypair.privateKey
      );

    }
    else {

      // TODO: Will this ever be the case?
      if (outputAddresses.addresses.length !== this.players.length) {
        console.log('Not enough output addresses!');
        return this.writeDebugFile();
      }

      console.log('Broadcasting shuffled output addresses!');

      this.comms.sendMessage('broadcastFinalOutputAddresses',
        this.session, me.playerNumber, shuffleArray(outputAddresses.addresses, 100),
        'broadcast', this.ephemeralKeypair.publicKey, this.ephemeralKeypair.privateKey
      );

    }

  }
  /*


    This function performs processing of the "broadcast" phase message sent by the final player
    in the round.  This message announces the final set of shuffled output addresses.
    This function does all of the following:

      - Check that the message was actually sent by the last player in the round.
      - Ensure our address is in list of output addresses. If not, blame and exit.
      - Broadcast our own "equivocation check" message.
      - Compute hash of outputs string and broadcast it.

  */
  checkFinalOutputsAndDoEquivCheck(signedPackets) {

    let finalOutputAddresses = _.map(signedPackets, 'packet.message.str')
    console.log('We got the final output addressess!', finalOutputAddresses);

    this.writeDebugFile();

  }

  //  This function implements processing of messages on Equivocation Check phase(phase # 4).
  //  It does the following:
  //
  //  - Check if inbox for this phase is complete.
  //
  //  - Verify if hashes from all players are the same. If it is not goes to the blame phase.
  //
  //  - If hashes are the same it sets the next phase as verification and submission phase.
  //
  //  - It makes a unsigned transaction, compute players inputs signature for this transaction and broadcast it.
  //
  processEquivCheckMessage() {

  }

  //  This function implements processing of messages on verification and submission phase (phase # 5).
  //  It does the following:
  //
  //   - Check if all players send its signatures.
  //
  //   - Verify the tx signature of all players. If there is a wrong signature go to the blame phase.
  //
  //   - Make signed transaction and broadcast it.
  //
  //   - Set done flag.

  verifyAndSubmit() {

  }

  //  Handles assiginment of blame because of equivocation failure.
  //  It does the following:
  //
  //   - Get messages from every player.
  //
  //   - Restore what messages were sent and what messages was received.
  //
  //   - Find if some player broadcast not the same values to the different players.
  //
  //   - If there is a cheater - cheater is banned.
  //
  //   - Protocol starts without cheater.

  // When we receive a message from another player
  // accusing someone of violating the protocol.
  handleBlameMessage(messageObject) {
    let keyOfAccused = _.get(messageObject, 'message.blame.accused.key');
    // console.log('The shuffle has failed!\n\t\tBlame has been assigned to', blame.accused.key,'because', blame.reason);

    let accused = _.find(this.players, { verificationKey: keyOfAccused });

    if (accused.isMe) {
      console.log('IM THE ONE BEING BLAMED!')
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
  assignBlame(voilationType, details) {

    let culprit = details.culprit;

    if (culprit.isMe) {
      console.log('Something went wrong and its all my fault', details.violation);
    }
    else {
      console.log('Blame has been assigned to', culprit, 'because', details.violation);

      // TODO:
      // Broadcast a blame message and formally accuse the culprit

    }

    this.writeDebugFile();

  }

}

module.exports = ShuffleRound;
