const bch = require('bitcoincashjs-fork');
const Transaction = bch.Transaction;
const Address = bch.Address;
const Script = bch.Script;
const crypto = bch.crypto;
const PublicKey = bch.PublicKey;
const PrivateKey = bch.PrivateKey;
const Message = require('./BetterMessage.js');

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
  }

};

