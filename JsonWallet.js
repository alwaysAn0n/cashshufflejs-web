const _ = require('lodash');

const BITBOXSDK = require('bitbox-sdk');
const BITBOX = new BITBOXSDK({ restURL: 'https://rest.bitcoin.com/v2/' })

const fs = require('fs')
const qrcode = require('qrcode-terminal');
const socketio = require('socket.io-client');

// Async-await compatible timeout function
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const currentPath = __filename.substring(0, __filename.lastIndexOf('/'));
process.chdir(currentPath);

class JsonWalletAddress {
  constructor(options) {
    return _.extend(this, options);
  }

  fund() {
    console.log(`\n\n\t Add funds to ${this.cashAddress} ( ${ this.legacyAddress })\n\n`);
    return qrcode.generate(this.cashAddress);
  }

  sweep() {
    console.log(`\n\n\t Sweeping funds for ${this.cashAddress} ( ${ this.legacyAddress })\n\n`);
    return qrcode.generate(this.privateKeyWif);
  }

}

class JsonWallet {
  constructor(options) {

    this.walletData = {
      name: 'test_json_wallet',
      file: options.file,
      created: new Date().getTime(),
      lastUpdated: new Date().getTime(),
      derivationTemplate: `m/44'/0'/z'/y/x`,
      addresses: []
    };

    this.masterHDNode;

    this.BITBOX = BITBOX;

    this.socket = socketio('https://cashexplorer.bitcoin.com/', {transports: ['websocket'], upgrade: false});
    this.socket.on('error', function(){
      console.log(arguments);
    });

    this.socket.on('connect', (stuff) => {
      console.log('Websockets connection to Bitcoin.com established');
      this.socket.emit('subscribe', 'inv');
    });

    this.socket.on('tx', async(data) => {

      let outputAddresses = data.vout.reduce((keepers, oneObject) => {
        return _.uniq(_.flatten(_.concat(keepers,_.keys(oneObject))));
      }, []);

      let affected = _.intersection(_.map(this.walletData.addresses, 'legacyAddress'), outputAddresses);

      if (!affected.length) {
        return;
      }
      else {
        console.log(`\n\n\t You got new money in ${ affected })\n\n`);
        await delay(1000);
        this.updateAddresses();
      }

    });


    if (options.file) {

      let createNewWallet = false;

      let walletData;
      try {
        walletData = require(options.file);

        if (!walletData.words) {
          createNewWallet = true;
        }

      }
      catch(nope) {
        console.log(`No wallet found.  Creating a fresh one at ${this.currentPath}/test_json_wallet `);
        createNewWallet = true;
      }

      if ( createNewWallet ) {
        // create 256 bit BIP39 mnemonic
        this.walletData.words = BITBOX.Mnemonic.generate(
          128,
          BITBOX.Mnemonic.wordLists()['english']
        );

      }
      else {
        _.extend(this.walletData, walletData);
      }

      this.masterHDNode = BITBOX.HDNode.fromSeed(BITBOX.Mnemonic.toEntropy(this.walletData.words));

      console.log(`test_json_wallet json wallet is loaded and ready to use`);

      this.walletData.lastUpdated = new Date().getTime();

      this.save();

      return this;

    }
    else {

      console.log('Creating new HD Wallet');

      // create 256 bit BIP39 mnemonic
      this.walletData.words = BITBOX.Mnemonic.generate(
        128,
        BITBOX.Mnemonic.wordLists()['english']
      );

      // master HDNode
      this.masterHDNode = BITBOX.HDNode.fromSeed(BITBOX.Mnemonic.toSeed(this.walletData.words));

      _.extend(this.walletData, writeThisToDisk);

      this.save();

    }

    return this;
  }

  get addresses() {
    return this.walletData.addresses.map((oneAddress) => {return new JsonWalletAddress(_.cloneDeep(oneAddress));});
  }

  // Return a deep-cloned array of all the unshuffled coins
  // that reside in every address in our wallet that isn't
  // under the derivation path this wallet reserves strictly
  // for shuffled coins.
  //
  // In this case, we've reserved the entire derivation path
  // `m/44'/0'/0'/1570/<x>` to store shuffled coins. While the
  // number 1570 is of no particular importance, it happens to
  // be the sum of the digits that form the decimal representation
  // of the english language phrase "liberty or death" :)
  get unshuffledCoins() {

    let unshuffled = _.filter(this.walletData.addresses, (oneAddress) => {
      return oneAddress.y !== 1570 && oneAddress.balanceSatoshis;
    });

    let unshuffledCoins = _.map(unshuffled, function(oneAddress) {
      return _.map(oneAddress.coins, function(oneCoin) {
        oneCoin.frozen = oneAddress.frozen;
        return oneCoin;
      });
    });

    return _.cloneDeep( _.orderBy( _.compact( _.flatten( unshuffledCoins ) ), ['amountSatoshis'], ['desc'] ) );
  }

  get shuffledCoins() {

    let shuffled = _.filter(this.walletData.addresses, (oneAddress) => {
      return oneAddress.y === 1570 && oneAddress.balanceSatoshis;
    });

    let shuffledCoins = _.map(shuffled, function(oneAddress) {
      return _.map(oneAddress.coins, function(oneCoin) {
        oneCoin.frozen = oneAddress.frozen;
        return oneCoin;
      });
    });

    return _.cloneDeep( _.orderBy( _.compact( _.flatten( shuffledCoins ) ), ['amountSatoshis'], ['desc'] ) );
  }

  get coins() {

    let all = _.filter(this.walletData.addresses, (oneAddress) => {
      return oneAddress.balanceSatoshis;
    });

    let coins = _.map(all, function(oneAddress) {
      return _.map(oneAddress.coins, function(oneCoin) {
        oneCoin.frozen = oneAddress.frozen;
        return oneCoin;
      });
    });

    return _.cloneDeep( _.orderBy( _.compact( _.flatten( coins ) ), ['amountSatoshis'], ['desc'] ) );
  }

  get fresh() {
    return {
      shuffle: this.freshAddressFromY.bind(this, 1570, true),
      change: this.freshAddressFromY.bind(this, 0, true),
      deposit: this.freshAddressFromY.bind(this, 0, false, true)
    };
  }

  freshAddressFromY(yPathVal, freezeAddressOnReturn, returnJsonAddressInstance) {
    freezeAddressOnReturn = freezeAddressOnReturn || false;

    let addressQuery = {
      y: Number(yPathVal),
      used: false,
      frozen: false
    };

    let unusedAddress = _.find(this.walletData.addresses, addressQuery);

    let largestShuffled = _.maxBy( _.filter(this.walletData.addresses, {
      y: Number(yPathVal)
    }), 'x');

    let useX = largestShuffled ? largestShuffled.x+1 : 0;

    let addressToReturn;
    if (unusedAddress) {
      addressToReturn = _.extend(unusedAddress, { frozen: freezeAddressOnReturn });
      this.save();
    }
    else {
      addressToReturn = this.newAddress(`m/44'/0'/0'/${yPathVal}/${useX}`, undefined, { frozen: freezeAddressOnReturn });
    }
    return returnJsonAddressInstance ? new JsonWalletAddress( _.cloneDeep(addressToReturn) ) : _.cloneDeep(addressToReturn);

  }


  freezeAddresses(oneOrMoreAddresses) {
    oneOrMoreAddresses = _.isArray(oneOrMoreAddresses) ? oneOrMoreAddresses : [oneOrMoreAddresses];

    let results = {
      success: [],
      fail: []
    };

    _.each(oneOrMoreAddresses, (oneAddress) => {

      let frozenAddress = _.find(this.walletData.addresses, {
        cashAddress: BITBOX.Address.toCashAddress(oneAddress)
      });

      if (!frozenAddress) {
        results.fail.push(oneAddress);
      }
      else {
        let updatedAddress = _.extend(frozenAddress, { frozen: true });
        results.success.push(oneAddress);
      }
      return;
    });

    this.save();

    return results;
  }

  unfreezeAddresses(oneOrMoreAddresses) {
    oneOrMoreAddresses = _.isArray(oneOrMoreAddresses) ? oneOrMoreAddresses : [oneOrMoreAddresses];

    let results = {
      success: [],
      fail: []
    };

    _.each(oneOrMoreAddresses, (oneAddress) => {

      let frozenAddress = _.find(this.walletData.addresses, {
        cashAddress: BITBOX.Address.toCashAddress(oneAddress)
      });

      if (!frozenAddress) {
        results.fail.push(oneAddress);
      }
      else {
        let updatedAddress = _.extend(frozenAddress, { frozen: false });
        results.success.push(oneAddress);
      }
      return;
    });

    this.save();

    return results;
  }

  save() {

    // console.log(`Now saving ${this.walletData.name} json wallet to ${this.walletData.file}`);
    let walletData = JSON.stringify(this.walletData, null, 2);

    // TODO: Abstract this into a generic "wallet persistence" mechanism
    fs.writeFileSync(this.walletData.file, 'module.exports = '+walletData+';');
    return;
  }

  newAddress(derivationPath, useTemplatePath, addressMeta) {
    useTemplatePath = useTemplatePath ? useTemplatePath.toLowerCase() : undefined;
    if (useTemplatePath && ['x', 'y', 'z'].indexOf(useTemplatePath) === -1) {
      console.log(`Incorrect wallet path!  Must use 'x', 'y', or 'z'`);
      throw new Error('bad_path');
    }

    const _makeAddress = (query) => {
      let x = Number(query.x);
      let y = query.y ? Number(query.y) : 0;
      let z = query.z ? Number(query.z) : 0;

      let addressDerivationString = `m/44'/0'/${z}'/${y}/${x}`;

      let childNode = this.masterHDNode.derivePath(addressDerivationString);

      let addressData = {
        x: x,
        y: y,
        z: z,
        derivationString: addressDerivationString,
        cashAddress: BITBOX.HDNode.toCashAddress(childNode),
        legacyAddress: BITBOX.HDNode.toLegacyAddress(childNode),
        privateKeyWif: BITBOX.HDNode.toWIF(childNode),
        coins: []
      };

      // If additional properties were given,
      // add this to this address before we save
      // it.
      if (addressMeta) {
        _.extend(addressData, addressMeta);
      }

      this.walletData.addresses.push(addressData);

      this.save();

      return addressData;

    };

    if (!derivationPath && !useTemplatePath) {
      if (!this.walletData.addresses.length) {
        return _makeAddress({ x:0 });
      }
      else {
        useTemplatePath = 'x';
      }

    }

    if (derivationPath) {
      let splitPath = derivationPath.split('/');

      return _makeAddress({
        x: Number(splitPath[5].replace(/(\D)/ig,'')),
        y: Number(splitPath[4].replace(/(\D)/ig,'')),
        z: Number(splitPath[3].replace(/(\D)/ig,'')),
      });

    }
    else {
      let largest = _.maxBy(this.walletData.addresses, useTemplatePath);
      let query = {};
      query[useTemplatePath] = largest[useTemplatePath]+1;
      return _makeAddress(query);
    }
  }

  async updateAddresses(updateAllAddresses, onlyUpdateThese) {
    // If this function is only being asked to update a specific
    // list of addresses, make sure they are in cashAddress format.
    onlyUpdateThese = _.map(onlyUpdateThese, function(oneThing) {
      return _.isString(oneThing) ? BITBOX.Address.toCashAddress(oneThing) : oneThing.cashAddress;
    }) || [];
    // If an address has been used and contains no coins,
    // only update it once every 30 minutes
    let updateDeadFrequency = 1000*60*30;

    let maxAddressesPerCall = 15;

    let filteredAddresses = _.reduce(this.walletData.addresses, function(keepers, oneAddress) {

      let addressIsDead = oneAddress.balanceSatoshis <= 0 && oneAddress.used;
      let deadAddressNeedsUpdating = new Date().getTime() >= oneAddress.lastUpdated+updateDeadFrequency;

      if (onlyUpdateThese.length) {
        if (onlyUpdateThese.indexOf(oneAddress.cashAddress) > -1) {
          keepers.push(oneAddress);
        }
      }
      else if (updateAllAddresses || !addressIsDead) {
        keepers.push(oneAddress);
      }
      else {
        if (deadAddressNeedsUpdating) {
          keepers.push(oneAddress);
        }
      }
      return keepers;
    }, []);

    let addressesToUpdate = _.map(filteredAddresses, 'cashAddress');

    // Get all the utxos for each address in our wallet
    let utxoInfo = [];
    while (addressesToUpdate.length) {
      let grabThese = addressesToUpdate.splice(addressesToUpdate, maxAddressesPerCall);
      let someUtxos;
      try {
        someUtxos = await BITBOX.Address.utxo(grabThese);
        _.each(someUtxos, (oneThing) => { utxoInfo.push(oneThing) });

      }
      catch (nope) {
        console.log(`\n\n UtxoFetch Error: That didn't work! ${nope.response.status}: ${nope.response.statusText}\n\n`);
        continue;
      }

      if (addressesToUpdate.length) {
        await delay(750);
      }
    }

    // Get address details for all our addresses
    let allCashAddresses = _.map(filteredAddresses, 'cashAddress');

    // Get all the utxos for each address in our wallet
    let allAddressDetails = [];
    while (allCashAddresses.length) {

      let someDetails;
      try {
        someDetails = await BITBOX.Address.details(allCashAddresses.splice(allCashAddresses, maxAddressesPerCall));
        _.each(someDetails, (oneThing) => { allAddressDetails.push(oneThing) });
      }
      catch(nope) {
        console.log(`Couldnt fetch some address details: ${nope.message}`);
        continue;
      }

      if (allCashAddresses.length) {
        await delay(750);
      }
    }

    for (let oneAddressObject of this.walletData.addresses) {

      let filteredAddress = _.find(filteredAddresses, {
        cashAddress: oneAddressObject.cashAddress
      });

      if (!filteredAddress) {
        continue;
      }

      let addressDetails = _.find(allAddressDetails, { cashAddress: oneAddressObject.cashAddress });
      let addressUtxoInfo = _.find(utxoInfo, { cashAddress: oneAddressObject.cashAddress });

      let coinsInAddress = _.reduce(addressUtxoInfo.utxos, (coins, oneUtxo) => {

        coins.push({
          txid: oneUtxo.txid,
          vout: oneUtxo.vout,
          height: oneUtxo.height,
          confirmations: oneUtxo.confirmations,
          amountSatoshis: oneUtxo.satoshis,
          legacyAddress: addressUtxoInfo.legacyAddress,
          cashAddress: addressUtxoInfo.cashAddress,
          scriptPubKey: addressUtxoInfo.scriptPubKey,
          privateKeyWif: oneAddressObject.privateKeyWif,
          lastUpdated: new Date().getTime()
        });

        return coins;
      }, []);

      _.extend(oneAddressObject, {
        frozen: oneAddressObject.frozen ? true : false,
        legacyAddress: oneAddressObject.legacyAddress,
        cashAddress: oneAddressObject.cashAddress,
        balanceSatoshis: _.sumBy(coinsInAddress, 'amountSatoshis'),
        used: addressDetails.txApperances ? true : false,
        coins: coinsInAddress,
        lastUpdated: new Date().getTime()
      });

    }

    this.save();

    let stats = _.reduce(this.walletData.addresses, function(stats, oneAddress) {
      stats.addresses++;
      stats.balance += _.sumBy(oneAddress.coins, 'amountSatoshis');
      stats.coins += oneAddress.coins.length;
      stats.shuffledCoins += oneAddress.y === 1570 ? oneAddress.coins.length : 0;
      stats.shuffledBalance += oneAddress.y === 1570 ? _.sumBy(oneAddress.coins, 'amountSatoshis') : 0;
      stats.activeAddresses += oneAddress.balanceSatoshis || !oneAddress.used ? 1 : 0;
      return stats;
    }, {
      addresses: 0,
      activeAddresses: 0,
      balance: 0,
      coins: 0,
      shuffledCoins: 0,
      shuffledBalance: 0
    });

    let formatNumber = function(someNumber) {
      return (someNumber.toString().split('').reverse().join('')).replace(/(\d{3})/g,'$1,').split('').reverse().join('')
    };

    stats.balance = formatNumber(stats.balance)+' sats or ~'+ ( Number( Math.floor(BITBOX.BitcoinCash.toBitcoinCash(stats.balance) ) ).toLocaleString() )+' bch';
    stats.shuffledBalance = formatNumber(stats.shuffledBalance)+' sats or ~'+ ( Number( Math.floor(BITBOX.BitcoinCash.toBitcoinCash(stats.shuffledBalance) ) ).toLocaleString() ) +' bch';

    console.log('\n\nWallet Stats');
    for (let oneProp in stats) {
      console.log('\t\t', _.capitalize(oneProp), ':', stats[oneProp]);
    }
    console.log('\n\n');

    return this;

  }


  async send(sendOptions) {

    // Accepts single or collection of JsonWallet `coin` formatted objects
    let fromCoins = _.isArray(sendOptions.from) ? sendOptions.from : [sendOptions.from];

    // Amount to be sent to the single bitcoin address included in the `sendOptions.to` param;
    let toAmountSatoshis = sendOptions.amountSatoshis || undefined;

    // Accepts single bitcoin address or array of objects, each containing a `cashAddress` field and `amountSatoshis` field
    let to = !_.isArray(sendOptions.to) ? [ { cashAddress: BITBOX.Address.toCashAddress(sendOptions.to), amountSatoshis: sendOptions.amountSatoshis} ] : sendOptions.to;

    try {
      await this.updateAddresses(undefined, _.uniq(_.compact(_.map(fromCoins, 'cashAddress'))) );
    }
    catch(nope) {
      console.log('Cannot update addresses', nope);
      throw nope;
    }

    let useOpReturn = sendOptions.opreturn || undefined;

    // Start building the transaction

    let transactionBuilder = new BITBOX.TransactionBuilder('mainnet');

    let tx = {};

    tx.inputs = _.reduce(fromCoins, (keepers, oneCoin, arrayIndex) => {

      let updatedCoin = _.find(this.coins, { txid: oneCoin.txid, vout: oneCoin.vout });

      if (updatedCoin) {
        _.extend(updatedCoin, {
          vin: arrayIndex,
          ecpair: BITBOX.ECPair.fromWIF(oneCoin.privateKeyWif)
        });
        keepers.push(updatedCoin);
      }
      return keepers;
    }, []);

    if (useOpReturn) {
      tx.feesNeeded = BITBOX.BitcoinCash.getByteCount({ P2PKH: tx.inputs.length }, { P2PKH: to.length + 2 });
    }
    else {
      tx.feesNeeded = BITBOX.BitcoinCash.getByteCount({ P2PKH: tx.inputs.length }, { P2PKH: to.length });
    }

    tx.outputs = _.reduce(to, (keepers, oneToObject, arrayIndex) => {

      oneToObject.vout = arrayIndex;

      oneToObject.legacyAddress = BITBOX.Address.toLegacyAddress(oneToObject.cashAddress);

      // Override this field if the sendAll or toAmountSatoshis params were included.
      oneToObject.amountSatoshis = sendOptions.sendAll ? _.sumBy(tx.inputs, 'amountSatoshis') : oneToObject.amountSatoshis || toAmountSatoshis;

      // Calculate this outputs contribution towards the transaction fees fees
      oneToObject.feeAmountSatoshis = Math.ceil( tx.feesNeeded / to.length );

      // Now adjust the output amount for it's contribution towards transaction fees
      oneToObject.amountSatoshis -= oneToObject.feeAmountSatoshis;

      keepers.push(oneToObject);

      return keepers;
    }, []);

    for (let oneOutput of _.orderBy(tx.outputs, ['vout'], ['asc'])) {
      transactionBuilder.addOutput(oneOutput.legacyAddress, oneOutput.amountSatoshis);
    }

    if (useOpReturn) {
      transactionBuilder.addOutput(BITBOX.Script.nullData.output.encode(Buffer.from(useOpReturn, 'ascii')), 0);
    }

    for (let oneInput of _.orderBy(tx.inputs, ['vin'], ['asc'])) {
      transactionBuilder.addInput(oneInput.txid, oneInput.vout);
      // transactionBuilder.sign(oneInput.vin, oneInput.ecpair, undefined/*redeemScript*/, transactionBuilder.hashTypes.SIGHASH_ALL, oneInput.amountSatoshis, transactionBuilder.signatureAlgorithms.SCHNORR);
    }
    for (let oneInput of _.orderBy(tx.inputs, ['vin'], ['asc'])) {
      transactionBuilder.sign(oneInput.vin, oneInput.ecpair, undefined/*redeemScript*/, transactionBuilder.hashTypes.SIGHASH_ALL, oneInput.amountSatoshis);
    }


    let returnData = _.extend(tx, {
      tx: transactionBuilder.build(),
      feeSatoshis: _.sumBy(tx.outputs, 'feeAmountSatoshis'),
      valueInSatoshis: _.sumBy(tx.inputs, 'amountSatoshis'),
      valueOutSatoshis: _.sumBy(tx.outputs, 'amountSatoshis'),
      txSize: tx.feesNeeded
    });

    console.log('Got TX:', returnData);

    return returnData;

  }

  async sendAllTo(someAddress) {
    someAddress = BITBOX.Address.toCashAddress(someAddress);

    let coinToSend = this.coins;

    let sendResults;
    try {
      sendResults = await this.send({
        from: coinToSend,
        to: someAddress,
        sendAll: true
      });
    }
    catch(nope) {
      console.log('Cannot send:', nope);
    }
    return sendResults;
  }

  async testSend() {
    let coinToSend = _.find(this.coins, 'amountSatoshis');
    let sendResults;
    try {
      sendResults = await this.send({
        from: coinToSend,
        to: this.fresh.change().cashAddress,
        sendAll: true
      });
    }
    catch(nope) {
      console.log('Cannot send:', nope);
    }
    return sendResults;
  }

};

module.exports = JsonWallet;
