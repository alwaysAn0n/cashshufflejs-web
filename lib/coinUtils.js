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
// const Message = require('./lib/BetterMessage.js');
const dust_threshold = 546;

// TODO: Replace all http calls with async-await
// style calls using axios.  Or just use Bitbox.
const https = require('https');

const blockchairEndpoint = 'https://api.blockchair.com/bitcoin-cash/dashboards/transaction/';

const getLegacyAddress = function(address) {

  try {
    if (address.length === 34) {
      return Address.fromString(address).toString();
    } else {
      try {
        return Address.fromString('bitcoincash:' + address.split(':').slice(-1)[0], 'livenet', 'pubkeyhash', Address.CashAddrFormat).toString();
      } catch (error) {

        try {
          return Address.fromString('bchtest:' + address.split(':').slice(-1)[0], 'testnet', 'pubkeyhash', Address.CashAddrFormat).toString();
        } catch (error) {
          throw error;
        }
      }
    }
  } catch (error) {
    throw error;
  }
};

const inputName = function(input) {
  return input.prevTxId.toString('hex') + ":" + input.outputIndex;
};

module.exports = {

  buildCoinFromPrivateKey: function(secretHex) {

    let coin = {};
    try {
      coin.privateKey = new PrivateKey(secretHex);
    } catch (error) {
      throw error;
    }

    coin.publicKey = coin.privateKey.toPublicKey();
    coin.legacyAddress = coin.publicKey.toAddress().toString();
    coin.cashAddress = coin.publicKey.toAddress()._toStringCashAddr();

    return coin;
  },

  getCoinDetails: function(prevTxId, outputNumber) {
    return new Promise(function(resolve, reject) {
      let request = https.get(blockchairEndpoint + prevTxId, function(response) {
        if (response.statusCode < 200 || response.statusCode > 299) {
          reject(new Error('Failed to get data ' + response.statusCode));
        }
        return response.on('data', function(data) {
          let coinOutput, error, output;
          try {
            output = JSON.parse(data.toString()).data[prevTxId].outputs[outputNumber];
            coinOutput = {
              txid: output.transaction_hash,
              vout: output.index,
              legacyAddress: getLegacyAddress(output.recipient),
              cashAddress: new Address(getLegacyAddress(output.recipient))._toStringCashAddr(),
              script: output.script_hex,
              satoshis: output.value,
              is_spent: output.is_spent
            };
            console.log('got coin:', coinOutput);
            return resolve(coinOutput);
          } catch (error) {
            return reject(error);
          }
        });
      });
      return request.on('error', function(error) {
        return reject(error);
      });
    });
  },

  checkSufficientFunds: function(inputs, amount) {
    return new Promise(function(resolve, reject) {
      return getCoins(inputs).then(function(coins) {
        let allNotSpent, coin, isEnoughFunds, pubkey, result, value;
        isEnoughFunds = [];
        for (pubkey in coins) {
          value = [
            (function() {
              let results;
              results = [];
              for (coin in coins[pubkey]) {
                results.push(coins[pubkey][coin]['satoshis']);
              }
              return results;
            })()
          ][0].reduce(function(x, y) {
            return x + y;
          }, 0);
          allNotSpent = [
            (function() {
              let results;
              results = [];
              for (coin in coins[pubkey]) {
                results.push(coins[pubkey][coin]['is_spent']);
              }
              return results;
            })()
          ][0].reduce(function(x, y) {
            return x || y;
          }, false);
          isEnoughFunds.push((!allNotSpent) && (value > amount));
        }
        result = isEnoughFunds.reduce(function(x, y) {
          return x && y;
        }, true);
        return resolve(result);
      }).catch(function(error) {
        return reject(error);
      });
    });
  },

  makeUnsignedTransaction: function(amount, fee, allInputs, outputs, changes) {
    return new Promise(function(resolve, reject) {
      let inputs, player, players, promises, txIns;
      promises = [];
      players = [];
      txIns = {};
      for (player in allInputs) {
        inputs = allInputs[player];
        players.push(player);
        promises.push(getCoins(inputs));
      }
      return Promise.all(promises).then(function(result) {
        let address, amounts, coin, coins, i, input, j, k, l, len, len1, len2, output, pubkey, ref, ref1, tx, txChanges, txIn, txOutputs, utxos;
        utxos = [];
        amounts = {};
        for (i = j = 0, len = result.length; j < len; i = ++j) {
          inputs = result[i];
          amounts[players[i]] = 0;
          for (pubkey in inputs) {
            coins = inputs[pubkey];
            for (coin in coins) {
              output = coins[coin];
              txIns[coin] = pubkey;
              amounts[players[i]] += output.satoshis;
              utxos.push(Transaction.UnspentOutput(output));
            }
          }
        }
        utxos.sort(function(a, b) {
          if ((a.txId + a.outputIndex) > (b.txId + b.outputIndex)) {
            return 1;
          } else {
            return -1;
          }
        });
        txOutputs = (function() {
          let k, len1, results;
          results = [];
          for (k = 0, len1 = outputs.length; k < len1; k++) {
            address = outputs[k];
            results.push([getLegacyAddress(address), amount]);
          }
          return results;
        })();
        players.sort();
        txChanges = (function() {
          let k, len1, results;
          results = [];
          for (k = 0, len1 = players.length; k < len1; k++) {
            player = players[k];
            if ((amounts[player] - amount - fee) > 0) {
              results.push([changes[player], amounts[player] - amount - fee]);
            }
          }
          return results;
        })();
        txChanges.sort(function(a, b) {});
        tx = Transaction().from(utxos);
        ref = [...txOutputs, ...txChanges];
        for (k = 0, len1 = ref.length; k < len1; k++) {
          output = ref[k];
          tx.to(getLegacyAddress(output[0]), output[1]);
        }
        ref1 = tx.inputs;
        for (l = 0, len2 = ref1.length; l < len2; l++) {
          input = ref1[l];
          input.sequenceNumber = 0xfffffffe; // fix sequence number for EC compatibility
          txIn = inputName(input);
          input.setScript(Script("21" + txIns[txIn]));
        }
        return resolve(tx);
      }).catch(function(error) {
        return reject(error);
      });
    });
  },

  getTransactionSignature: function(transaction, inputs, secretKeys) {
    let inputSignature, inputsPubkeys, j, len, privkey, pubkey, ref, signature, signatures, temp, txHash;
    signatures = {};
    inputsPubkeys = Object.keys(inputs);
    for (pubkey in secretKeys) {
      privkey = secretKeys[pubkey];
      if (indexOf.call(inputsPubkeys, pubkey) >= 0) {
        ref = transaction.getSignatures(privkey);
        for (j = 0, len = ref.length; j < len; j++) {
          signature = ref[j];
          txHash = inputName(signature);
          inputSignature = Buffer.from(signature.signature.toString() + "41", 'utf-8'); // nHashType == 65 only for now.
          temp = {};
          temp[txHash] = inputSignature;
          Object.assign(signatures, temp);
        }
      }
    }
    return signatures;
  },

  addTransactionSignatures: function(transaction, signatures) {
    let input, j, len, pubkey, ref, results, signature, txIn;
    ref = transaction.inputs;
    results = [];
    for (j = 0, len = ref.length; j < len; j++) {
      input = ref[j];
      txIn = inputName(input);
      pubkey = (input._scriptBuffer.toString('hex')).slice(2);
      signature = Buffer.from(signatures[txIn].toString('utf-8').slice(0, -1), 'hex');
      results.push(input.setScript(Script.buildPublicKeyHashIn(pubkey, signature, 0x41)));
    }
    return results;
  },

  verifyTransactionSignature: function(signature, transaction, verificationKey, txHash) {
    let inputIndex, signatureCrypto, signatureObject;
    inputIndex = transaction.inputs.map(inputName).indexOf(txHash);
    if (inputIndex > 0) {
      signatureCrypto = crypto.Signature.fromTxFormat(Buffer.from(signature.toString('utf-8'), 'hex'));
      signatureObject = {
        signature: signatureCrypto,
        publicKey: PublicKey(verificationKey),
        inputIndex: inputIndex,
        sigtype: signatureCrypto.nhashtype
      };
      return transaction.inputs[inputIndex].isValidSignature(transaction, signatureObject);
    } else {
      return false;
    }
  },

  verifySignature: function(signature, message, verificationKey) {
    let address, messageBase64, signatureBase64;
    address = PublicKey(verificationKey).toAddress();
    messageBase64 = message.toString('base64');
    signatureBase64 = signature.toString('base64');
    return Message(messageBase64).verify(address, signatureBase64);
  },

  buildShuffleTransaction: async function(options) {

    let feeSatoshis = options.feeSatoshis;

    // If this field is left blank, it will be set later
    // to the lowest valued coin - fees
    let shuffleAmountSatoshis = options.shuffleAmountSatoshis;

    // Attach the players input address to their input.
    let players = _.map(options.players, function(onePlayer) {
      let pubKey = new PublicKey(onePlayer.coin.publicKey);
      _.extend(onePlayer.coin, {
        pubKey: pubKey,
        legacyAddress: pubKey.toAddress().toString(),
        cashAddress: pubKey.toAddress()._toStringCashAddr()
      });
      return onePlayer;
    });

    // Inputs are sorted by hash + position

    let addressesToFetch = _.map(players, 'coin.legacyAddress');
    console.log('Fetching utxos for:', addressesToFetch);
    let allCoinDetails;
    try {
      allCoinDetails = await BITBOX.Address.utxo(addressesToFetch);
    }
    catch(nope) {
      console.log('Something went wrong fetching utxo data:', nope);
      throw nope;
    }

    let allInputs = [];
    for (let onePlayer of _.orderBy(players, ['coin.txid'], ['asc'])) {

      let addressInQuestion = _.find(allCoinDetails, { legacyAddress: onePlayer.coin.legacyAddress });

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

      let coinInQuestion = _.find(addressInQuestion.utxos, { txid: onePlayer.coin.txid, vout: Number(onePlayer.coin.vout) });

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
        player: onePlayer,
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

    for (let oneOutput of _.orderBy(changeOutputsToAdd, ['verificationKey'], ['asc']) ) {
      if (oneOutput.amountSatoshis >= dust_threshold) {
        allOutputs.push( _.extend(oneOutput, { vout: allOutputs.length } ) );
      }
    }

    console.log('Building shuffle transaction between', players.length, 'for', shuffleAmountSatoshis, 'sats and using a fee of', feeSatoshis);

    // Instantiate the Bitbox transaction builder
    let transactionBuilder = new BITBOX.TransactionBuilder('bitcoincash');

    console.log('\n\nAdding Outputs\n\n');

    // Order the outputs then add them to the transaction
    for (let oneTxOutput of _.orderBy(allOutputs, ['vout'], ['asc'])) {

      console.log('\tAdding output:', oneTxOutput.cashAddress, oneTxOutput.amountSatoshis);
     
      transactionBuilder.addOutput(oneTxOutput.cashAddress, oneTxOutput.amountSatoshis);

    }

    console.log('\n\nAdding Inputs\n\n');

    // Order the inputs
    for (let oneTxInput of _.orderBy(allInputs, ['vin'], ['asc'])) {
      console.log(`\n\tAdding ${oneTxInput.txid}[${oneTxInput.vout}] with new index ${oneTxInput.vin}\n\n\t\tfrom ${oneTxInput.cashAddress} in the amount of ${oneTxInput.amountSatoshis}\n\n`);
      transactionBuilder.addInput(oneTxInput.txid, oneTxInput.vout);
    }

    let myShuffleInput = _.find(allInputs, 'player.isMe');

    console.log('\n\nSigning Inputs\n\n');

    let inputSigningPair;
    console.log(`\n\tSigning ${myShuffleInput.txid}[${myShuffleInput.vout}] with new index ${myShuffleInput.vin}\n\n\t\tfrom ${myShuffleInput.cashAddress} in the amount of ${myShuffleInput.amountSatoshis}\n\n`);
    try {
      inputSigningPair = BITBOX.ECPair.fromWIF(myShuffleInput.player.coin.privateKeyWif);
      transactionBuilder.sign(myShuffleInput.vin, inputSigningPair, undefined, transactionBuilder.hashTypes.SIGHASH_ALL, myShuffleInput.amountSatoshis);
    }
    catch(nope) {
      console.log('Cannot create ECPair from private key to sweep paper wallet:', nope);
      throw new Error('BAD_PAPER');
    }

    console.log('\n\nNow building transaction!\n\n');

    // Now let's build it!
    let tx;
    try {
      tx = transactionBuilder.transaction.buildIncomplete();
    }
    catch (nope) {
      console.log('Cannot build transaction:', nope);
      throw nope;
    }

    // This like the one below it match the EC
    let hexSignature = transactionBuilder
      .transaction
      .inputs[0]
      .signatures[0]
      .toString('hex');

    // let signature = inputSigningPair
    //   .sign(tx.getHash())
    //   .toScriptSignature(transactionBuilder.hashTypes.SIGHASH_ALL)
    //   .toString('base64');

    // The comments in the EC client mention DER format so I thought I would try this
    let derSignature = inputSigningPair
      .sign(tx.getHash())
      .toDER()
      .toString('hex');

    // console.log('\n\nPreparing to send:\n\t',txData);

    // console.log('transactionBuilder:', transactionBuilder);

    let hexTx = tx.toHex();

    // // Now convert the transaction to hex and broadcast it to
    // // our connected full node.
    let submissionResults;
    // try {
    //   submissionResults = await BITBOX.RawTransactions.sendRawTransaction(hexTx);
    // }
    // catch (nope) {
    //   console.log('Cannot broadcast transaction:', nope);
    //   throw nope;
    // }

    // if (!submissionResults) {
    //   console.log('\n\n*********** SUBMISSION RESULTS **************');
    //   console.log(require('util').inspect(submissionResults, null, 4));
    //   console.log('\n\n');
    // }

    // If the transaction fails but doesn't throw, make sure
    // it throws.
    let errorInfo;
    if (typeof submissionResults === 'string' && submissionResults.indexOf(':') > -1) {
      if (_.toNumber(submissionResults.split(':')[0])) {
        errorInfo = {
          code: Number(submissionResults.split(':')[0]),
          description: submissionResults.split(':')[1]
        };
      }
    }

    if (errorInfo&&errorInfo.code) {
      let someError = new Error('SUBMIT_ERROR');
      _.extend(someError, errorInfo);
      console.log('Cannot broadcast transaction:', someError);
      throw someError;
    }

    // console.log('Transaction broadcasted!', submissionResults);

    // Return the results
    let sendResults = {
      hex: hexTx,
      built: tx,
      allInputs: allInputs,
      allOutputs: allOutputs,
      transactionBuilder: transactionBuilder,
      signatureBase64: Buffer.from(derSignature, 'utf8').toString('base64'),
      ecpair: inputSigningPair,
      input: myShuffleInput
      // txData: txData,
      // transactionId: submissionResults
      // transaction: tx,
      // amountSatoshis: txData.total,
      // fee: txData.feesNeeded
    };

    return sendResults;

  }

};


// Paste this into the debugger tool
// var txData;tools.coin.buildShuffleTransaction({players:round.players, feeSatoshis: 270}).catch(console.log).then(function(t){txData=t;})
