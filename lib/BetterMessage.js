const _ = require('lodash');
const bch = require('bitcoincashjs-fork');
const $ = bch.util.preconditions;
const Address = bch.Address;
const PublicKey = bch.PublicKey;
const PrivateKey = bch.PrivateKey;
const BufferWriter = bch.encoding.BufferWriter;
const ECDSA = bch.crypto.ECDSA;
const Signature = bch.crypto.Signature;
const sha256sha256 = bch.crypto.Hash.sha256sha256;
const JSUtil = bch.util.js;

const MAGIC_BYTES = Buffer.from('Bitcoin Signed Message:\n');

/**
 * constructs a new message to sign and verify.  Now featuring typed buffers!
 *
 * @param {String} message
 * @returns {Message}
 */

class Message {

  constructor(message, messageEncoding) {
    messageEncoding = messageEncoding || 'utf8';
    if (!(this instanceof Message)) {
      return new Message(message, messageEncoding);
    }
    $.checkArgument(_.isString(message), 'First argument should be a string');
    this.message = message;
    this.messageEncoding = messageEncoding;
    return this;
  }

  get magicHash() {
    let prefix1 = BufferWriter.varintBufNum(MAGIC_BYTES.length);

    let messageBuffer = Buffer.from(this.message, this.messageEncoding);
    let prefix2 = BufferWriter.varintBufNum(messageBuffer.length);
    let buf = Buffer.concat([prefix1, MAGIC_BYTES, prefix2, messageBuffer]);
    let hash = sha256sha256(buf);
    return hash;
  }

  /**
   * Will sign a message with a given bitcoin private key.
   *
   * @param {PrivateKey} privateKey - An instance of PrivateKey
   * @returns {String} A base64 encoded compact signature
   */

  sign(privateKey) {
    $.checkArgument(privateKey instanceof PrivateKey,
      'First argument should be an instance of PrivateKey');
    let hash = this.magicHash;
    let ecdsa = new ECDSA();
    ecdsa.hashbuf = hash;
    ecdsa.privkey = privateKey;
    ecdsa.pubkey = privateKey.toPublicKey();
    ecdsa.signRandomK();
    ecdsa.calci();
    return ecdsa.sig.toCompact().toString('base64');
  }

  /**
   * Will return a boolean of the signature is valid for a given bitcoin address.
   * If it isn't the specific reason is accessible via the "error" member.
   *
   * @param {Address|String} bitcoinAddress - A bitcoin address
   * @param {String} signatureString - A base64 encoded compact signature
   * @returns {Boolean}
   */
  verify(bitcoinAddress, signatureString) {
    $.checkArgument(bitcoinAddress);
    $.checkArgument(signatureString && _.isString(signatureString));

    if (_.isString(bitcoinAddress)) {
      bitcoinAddress = Address.fromString(bitcoinAddress);
    }
    let signature = Signature.fromCompact(new Buffer(signatureString, 'base64'));

    let ecdsa = new ECDSA();
    // recover the public key
    ecdsa.hashbuf = this.magicHash;
    ecdsa.sig = signature;
    let publicKey = ecdsa.toPublicKey();

    let signatureAddress = Address.fromPublicKey(publicKey, bitcoinAddress.network);

    // check that the recovered address and specified address match
    if (bitcoinAddress.toString() !== signatureAddress.toString()) {
      this.error = 'The signature did not match the message digest';
      return false;
    }

    let verified = ECDSA.verify(this.magicHash, signature, publicKey);
    if (!verified) {
      this.error = 'The signature was invalid';
    }

    return verified;
  }

  /**
   * @returns {Object} A plain object with the message information
   */
  toObject() {
    return {
      message: this.message
    };
  }

  /**
   * @returns {String} A JSON representation of the message information
   */
  toJSON() {
    return JSON.stringify(this.toObject());
  }

  /**
   * Will return a the string representation of the message
   *
   * @returns {String} Message
   */
  toString() {
    return this.message;
  }

  /**
   * Will return a string formatted for the console
   *
   * @returns {String} Message
   */
  inspect() {
    return '<Message: ' + this.toString() + '>';
  }

};

/**
 * Instantiate a message from a message string
 *
 * @param {String} str - A string of the message
 * @returns {Message} A new instance of a Message
 */
Message.prototype.fromString = function(str) {
  return new Message(str);
};

/**
 * Instantiate a message from JSON
 *
 * @param {String} json - An JSON string or Object with keys: message
 * @returns {Message} A new instance of a Message
 */
Message.prototype.fromJSON = function fromJSON(json) {
  if (JSUtil.isValidJSON(json)) {
    json = JSON.parse(json);
  }
  return new Message(json.message);
};

Message.prototype.MAGIC_BYTES = MAGIC_BYTES;

module.exports = Message;
