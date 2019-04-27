/*
    Most of this code was borrowed with permission from 
    Cliford Symack - https://github.com/clifordsymack/

*/

const crypto = require('crypto');
const PrivateKey = require('bitcoincashjs-fork').PrivateKey;
const PublicKey = require('bitcoincashjs-fork').PublicKey;
const _ = require('lodash');

const _aesEncryptWithIV = function(key, iv, message) {
  let cipher, crypted;
  cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  cipher.setAutoPadding(true);
  crypted = cipher.update(message, 'hex', 'hex');
  crypted += cipher.final('hex');
  return Buffer.from(crypted, 'hex');
};

const _aesDecryptWithIV = function(key, iv, message) {
  let cipher, crypted;
  cipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
  cipher.setAutoPadding(true);
  crypted = cipher.update(message, 'hex', 'hex');
  crypted += cipher.final('hex');
  return Buffer.from(crypted, 'hex');
};

module.exports = {

  rebuildKeypair: function(somePrivateKey) {
    let keypair = {
      privateKey: new PrivateKey(somePrivateKey)
    };

    keypair.publicKey = keypair.privateKey.toPublicKey();
    keypair.publicKeyHex = keypair.publicKey.toString('hex');
    keypair.privateKeyHex = keypair.privateKey.toString('hex');

    return keypair;
  },

  generateKeypair: function() {
    let keypair = {
      privateKey: new PrivateKey
    };

    keypair.publicKey = keypair.privateKey.toPublicKey();
    keypair.publicKeyHex = keypair.publicKey.toString('hex');
    keypair.privateKeyHex = keypair.privateKey.toString('hex');

    return keypair;
  },

  encrypt: function(plaintextMessage, pubkey) {

    let publicKey = PublicKey(pubkey);
    let ephemeral = new PrivateKey;
    let ecdhKey = PublicKey(publicKey.point.mul(ephemeral.toBigNumber())).toBuffer();
    let key = crypto.createHash('sha512').update(ecdhKey).digest();
    let ciphertext = _aesEncryptWithIV(key.slice(16, 32), key.slice(0, 16), Buffer.from(plaintextMessage, 'utf8'));
    let encrypted = Buffer.concat([Buffer.from('BIE1'), ephemeral.publicKey.toBuffer(), ciphertext]);
    let mac = crypto.createHmac('sha256', key.slice(32)).update(encrypted).digest();

    return Buffer.concat([encrypted, mac]).toString('base64');
  },

  decrypt: function(encryptedMessage, somePrivateKeyHexString) {

    let privateKey = new PrivateKey(somePrivateKeyHexString);
    let encrypted = Buffer.from(encryptedMessage, 'base64');
    if (encrypted.length < 85) {
      throw 'invalid ciphertext: length';
    }

    let magic = encrypted.slice(0, 4);
    let ephemeralPubkey = encrypted.slice(4, 37);
    let ciphertext = encrypted.slice(37, -32);
    let mac = encrypted.slice(-32);

    if (magic.toString() !== 'BIE1') {
      throw 'invalid ciphertext: invalid magic bytes';
    }
    try {
      ephemeralPubkey = PublicKey(ephemeralPubkey);
    } catch (error) {
      throw 'invalid ciphertext: invalid ephemeral pubkey';
    }

    ephemeralPubkey.point.validate();
    let secretMultiplier = privateKey.toBigNumber();
    let ecdhKey = PublicKey(ephemeralPubkey.point.mul(secretMultiplier)).toBuffer();
    let key = crypto.createHash('sha512').update(ecdhKey).digest();
    let iv = key.slice(0, 16);
    let keyE = key.slice(16, 32);
    let keyM = key.slice(32);

    if (mac.toString('hex') !== crypto.createHmac('sha256', keyM).update(encrypted.slice(0, -32)).digest('hex')) {
      throw 'invalid password';
    }
    return _aesDecryptWithIV(keyE, iv, ciphertext);
  },

  // THIS HAS BEEN CHANGED.  UPDATE IT!
  hash: function(text, algorithm) {
    algorithm = algorithm || 'sha224';

    try {
      return crypto.createHash(algorithm).update(Buffer.from(text), 'utf8').digest();
    } catch (error) {
      return null;
    }
  }
};

