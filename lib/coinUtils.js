const bch = require('bitcoincashjs-fork');
const Transaction = bch.Transaction;
const Address = bch.Address;
const Script = bch.Script;
const crypto = bch.crypto;
const PublicKey = bch.PublicKey;
const PrivateKey = bch.PrivateKey;
const Message = require('./BetterMessage.js');

const _ = require('lodash');
const BITBOXSDK = require('bitbox-sdk');
const BITBOX = new BITBOXSDK();
const dust_threshold = 546;


// Currently all transaction functionality uses `bitcoincashjs-fork`
// which is no longer maintained and full of bugs.  I want to
// refactor all of this to use BITBOX for everything.

module.exports = {

  getKeypairFromWif: function(somePrivateKeyWif) {

    let coin = {};
    try {
      coin.privateKey = new PrivateKey(somePrivateKeyWif);
    }
    catch (error) {
      throw error;
    }

    coin.publicKey = coin.privateKey.toPublicKey();
    coin.legacyAddress = coin.publicKey.toAddress().toString();
    coin.cashAddress = coin.publicKey.toAddress()._toStringCashAddr();

    return coin;
  },

  checkSufficientFunds: function(inputs, amount) {

    // Currently this is done in the `getCoinDetails` function
    // and it's called just before we add the player to the round.
    // It's also done as we're building the shuffle transaction.
    // I want to break this functionality out so we can check from
    // any time.

  },

  getCoinDetails: async function(someTxid, someVout) {

    let txData;
    try {
      txData = await BITBOX.RawTransactions.getRawTransaction(someTxid, true);
    }
    catch(nope) {
      console.log('Something went wrong fetching transaction data');
      throw new Error('BAD_COIN');
    }

    let coinInQuestion = _.find(txData.vout, {
      n: Number(someVout)
    });
 
    if (!coinInQuestion) {
      throw new Error('BAD_COIN');
    }

    let utxoData;
    try {
      utxoData = await BITBOX.Address.utxo(coinInQuestion.scriptPubKey.addresses[0]);
    }
    catch(nope) {
      console.log('Something went wrong fetching utxo data:', nope.message);
      throw new Error('BAD_COIN');
    }

    let outputInQuestion = _.find(utxoData.utxos, {
      vout: Number(someVout),
      txid: someTxid
    });

    let coinData = {
      txid: someTxid,
      vout: Number(someVout),
      legacyAddress: BITBOX.Address.toLegacyAddress(coinInQuestion.scriptPubKey.addresses[0]),
      cashAddress: BITBOX.Address.toCashAddress(coinInQuestion.scriptPubKey.addresses[0]),
      script: coinInQuestion.scriptPubKey.hex,
      spent: outputInQuestion ? false : true
    };

    if (outputInQuestion) {
      _.extend(coinData, {
        amount: outputInQuestion.amount,
        amountSatoshis: Number(outputInQuestion.satoshis),
        height: outputInQuestion.height,
        confirmations:outputInQuestion.confirmations
      });
    }

    return coinData;

  },

  verifyTransactionSignature: function(shuffleTxInstance, inputSigData, publicKeyHexOfSigner) {

    let inputToSign = _.reduce(shuffleTxInstance.inputs, function(keeper, oneInput, arrayIndex) {
      // If we already found the right input, pass it through
      // without bothering to check the others;
      if (keeper) {
        return keeper
      }

      let asJson = oneInput.toObject();

      if (inputSigData.prevTxId === asJson.prevTxId && Number(inputSigData.vout) === Number(asJson.outputIndex) ) {
        return {
          input: oneInput,
          inputIndex: arrayIndex
        }
      }
      else {
        return undefined;
      }

    }, undefined);

    if (!inputToSign) {
      return false;
    }

    let signerPublicKey = bch.PublicKey(publicKeyHexOfSigner);
    let signatureInstance = bch.crypto.Signature.fromTxFormat(Buffer.from(inputSigData.signature, 'hex'));

    let signatureObject = {
      signature: signatureInstance,
      publicKey: signerPublicKey,
      inputIndex: inputToSign.inputIndex,
      sigtype: signatureInstance.nhashtype
    };

    let verificationResults = false;
    try {
      verificationResults = inputToSign.input.isValidSignature(shuffleTxInstance, signatureObject);
    }
    catch(nope) {
      verificationResults = false;
    }

    if (verificationResults) {
      return {
        success: true,
        inputIndex: signatureObject.inputIndex,
        signature: signatureObject
      };
    }
    else {
      return {
        success: false
      };
    }

  },

  // Normalizes and sorts all the transaction
  // inputs and outputs so the transaction
  // building logic can be kept clean and
  // simple.  This function also makes sure
  // inputs haven't been spent since they
  // were declared.
  prepareShuffleInsAndOuts: async function(options) {
    let feeSatoshis = options.feeSatoshis;

    // If this field is left blank, it will be set later
    // to the lowest valued coin - fees
    let shuffleAmountSatoshis = options.shuffleAmountSatoshis;

    // Attach the players input address to their input.
    let players = _.map(options.players, function(onePlayer) {
      let pubKey = new PublicKey(onePlayer.coin.publicKey);
      _.extend(onePlayer.coin, {
        vout: Number(onePlayer.coin.vout),
        pubKey: pubKey,
        legacyAddress: pubKey.toAddress().toString(),
        cashAddress: pubKey.toAddress()._toStringCashAddr()
      });
      return onePlayer;
    });

    // Inputs are sorted by hash + position

    let addressesToFetch = _.map(players, 'coin.legacyAddress');

    // console.log('Fetching utxos for:', addressesToFetch);

    let utxoData;
    try {
      utxoData = await BITBOX.Address.utxo(addressesToFetch);
    }
    catch(nope) {
      console.log('Something went wrong fetching utxo data:', nope);
      throw nope;
    }

    let allInputs = [];
    for (let onePlayer of _.orderBy(players, ['coin.txid', 'coin.vout'], ['asc', 'asc'])) {

      let addressInQuestion = _.find(utxoData, { legacyAddress: onePlayer.coin.legacyAddress });

      if (!addressInQuestion) {
        let errorToThrow = new Error('VERIFY_ERROR');
        _.extend(errorToThrow, {
          blame: {
            reason: 'BAD_INPUT',
            player: onePlayer
          }
        });
        throw errorToThrow;
      }

      let coinInQuestion = _.find(addressInQuestion.utxos, { txid: onePlayer.coin.txid, vout: onePlayer.coin.vout });

      if (!coinInQuestion) {
        let errorToThrow = new Error('VERIFY_ERROR');
        _.extend(errorToThrow, {
          blame: {
            reason: 'BAD_INPUT',
            player: onePlayer
          }
        });
        throw errorToThrow;
      }

      allInputs.push({
        player: _.cloneDeep(onePlayer),
        txid: onePlayer.coin.txid,

        // The output order of this coin inside it's
        // previous transaction.  The old index.
        vout: Number(onePlayer.coin.vout),

        // The order in which this coin will be included
        // in the transaction we're building now. This is
        // it's input index.  We will order by this.
        vin: allInputs.length,
        legacyAddress: addressInQuestion.legacyAddress,
        cashAddress: addressInQuestion.cashAddress,
        amountBch: coinInQuestion.amount,
        amountSatoshis: coinInQuestion.satoshis,
        confirmations: coinInQuestion.confirmations,
        scriptPubKey: addressInQuestion.scriptPubKey
      });

    }

    // Dynamically set the shuffleAmount if it wasn't
    // specified as an argument to this function.
    if (!shuffleAmountSatoshis) {
      shuffleAmountSatoshis = _.minBy(allInputs, 'amountSatoshis')['amountSatoshis'] - feeSatoshis;
    }

    let finalOutputAddresses = players[0].finalOutputAddresses;

    // Outputs are in the order they arrived in the packets.
    let allOutputs = [];
    for (let n=0; n < finalOutputAddresses.length; n++) {
      allOutputs.push({
        vout: n,
        legacyAddress: finalOutputAddresses[n],
        cashAddress: BITBOX.Address.toCashAddress(finalOutputAddresses[n]),
        amountSatoshis: shuffleAmountSatoshis
      })
    }

    // Since the shuffle amount ( according to CashShuffle
    // v300 spec) is set to the smallest coin value minus
    // fees within the round, this player won't get change.
    let changeAddressToExclude = _.get(_.minBy(allInputs, 'amountSatoshis'), 'player.change.legacyAddress');

    let changeOutputsToAdd = _.reduce(players, function(keepers, onePlayer) {
      if (onePlayer.change.legacyAddress !== changeAddressToExclude) {
        let playerInput = _.find(allInputs, { legacyAddress: onePlayer.coin.legacyAddress });
        keepers.push({
          player: onePlayer,
          verificationKey: onePlayer.verificationKey,
          legacyAddress: onePlayer.change.legacyAddress,
          cashAddress: BITBOX.Address.toCashAddress(onePlayer.change.legacyAddress),
          amountSatoshis: playerInput.amountSatoshis - (shuffleAmountSatoshis + feeSatoshis)
        });
      }
      return keepers;
    }, []);

    // Order the change amounts based on their verification
    // key then add them to the outputs array.
    for (let oneOutput of _.orderBy(changeOutputsToAdd, ['verificationKey'], ['asc']) ) {
      if (oneOutput.amountSatoshis >= dust_threshold) {
        allOutputs.push( _.extend(oneOutput, { vout: allOutputs.length } ) );
      }
    }

    return {
      inputs: _.orderBy(allInputs, ['vin'], ['asc']),
      outputs: _.orderBy(allOutputs, ['vout'], ['asc']),
      shuffleAmountSatoshis: shuffleAmountSatoshis,
      feeSatoshis: feeSatoshis,
      players: players
    };

  },

  // Builds the partially signed transaction
  // that will eventually be broadcast to the
  // the network.  It returns a serialized (as
  // JSON ) version of the transaction before
  // any signatures are added as well as the
  // fully formed transaction with only our
  // signature applied.
  getShuffleTxAndSignature: function(options) {
    let inputs = options.inputs;

    let outputs = options.outputs;

    let shuffleTransaction = new bch.Transaction();

    let myInput;
    for (let oneInput of inputs) {
      let playerPubKey = bch.PublicKey(oneInput.player.coin.publicKey);

      let txInput = new bch.Transaction.UnspentOutput({
        txid: oneInput.txid,
        outputIndex: oneInput.vout,
        address: playerPubKey.toAddress(),
        scriptPubKey: bch.Script.fromAddress(playerPubKey.toAddress()),
        satoshis: oneInput.amountSatoshis
      });

      shuffleTransaction.from( txInput );

      // For some stupid reason, bitcoincashjs's `PublicKeyHashInput`
      // instances are showing the outputIndex field which should be
      // type number or string as type 'undefined'.  Idfk, just be aware.
      let grabIt = _.find(shuffleTransaction.inputs, function (txInput) {
        let bufferString = txInput.prevTxId.toString('hex');
        return oneInput.txid === bufferString && Number(oneInput.vout) === Number(txInput.outputIndex);
      });

      // Fix the sequence number
      _.extend(grabIt, { sequenceNumber: 0xfffffffe });
      grabIt.setScript(bch.Script('21' + oneInput.player.coin.publicKey));

      if (oneInput.player.isMe) {
        myInput = oneInput;
      }

    }

    for (let oneOutput of outputs) {
      shuffleTransaction.to(oneOutput.legacyAddress, oneOutput.amountSatoshis)
    }

    let preSignedTx = shuffleTransaction.toObject();

    shuffleTransaction.sign( new bch.PrivateKey.fromWIF(myInput.player.coin.privateKeyWif) );

    let sigInstance = shuffleTransaction.getSignatures(myInput.player.coin.privateKeyWif)[0];

    return {
      serialized: preSignedTx,
      tx: shuffleTransaction,
      signature: sigInstance.signature.toTxFormat().toString('hex')
    };

  },

  // An intermediary function I can use to
  // switch between the different transaction
  // building methods I'm trying.
  buildShuffleTransaction: async function(options) {

    let insAndOuts;
    try {
      insAndOuts = await this.prepareShuffleInsAndOuts({
        players: options.players,
        feeSatoshis: options.feeSatoshis
      });
    }
    catch(nope) {
      console.log('cannot prepare inputs and outputs for shuffle Transaction');
      throw nope;
    }

    let shuffleTxData = await this.getShuffleTxAndSignature({
      inputs: insAndOuts.inputs,
      outputs: insAndOuts.outputs
    });

    // Return the results
    return {
      tx: shuffleTxData.tx,
      inputs: insAndOuts.inputs,
      outputs: insAndOuts.outputs,
      serialized: shuffleTxData.serialized,
      signatureBase64: Buffer.from(shuffleTxData.signature, 'utf-8').toString('base64')
    };

  },
  BITBOX: BITBOX
};
