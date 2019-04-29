const test = require('ava');

test('When rebuildKeypair is called, then correct public key is generated.', function (t) {
	const cryptoUtils = require('../lib/cryptoUtils');

	let originalKeypair = cryptoUtils.generateKeypair();
	let rebuiltKeypair = cryptoUtils.rebuildKeypair(originalKeypair.privateKey);

	t.is(originalKeypair.publicKeyHex, rebuiltKeypair.publicKeyHex);
});
