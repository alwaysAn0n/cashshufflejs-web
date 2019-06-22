const test = require('ava');
const _ = require('lodash');

class MockCommsChannel {
	constructor() {
		this.FunctionCalls = {
			'on': 0
		};

		this.OnCallbacks = {};
		this.SentMessages = [];
	}

	on (message, callback) {
		this.FunctionCalls['on']++;
		this.OnCallbacks[message] = callback;
	}

	resetSentMessages () {
		this.SentMessages = [];
	}

	getLastSentMessageArgs () {
		return this.SentMessages.length
			? this.SentMessages[this.SentMessages.length - 1]
			: [];
	}

	sendMessage () {
		this.SentMessages.push(arguments);
	}

	writeDebugFile () {
		console.log('pretending to write debug file');
	}
}

let getMockCommsChannel = function () {
	return new MockCommsChannel();
};

let getMockChangeAddress = function () {
	return 'pp8skudq3x5hzw8ew7vzsw8tn4k8wxsqsv0lt0mf3g'; // eatBCH (might as well go to charity if used by accident!)
};

let getMockShuffledCoinAddress = function () {
	return 'pp8skudq3x5hzw8ew7vzsw8tn4k8wxsqsv0lt0mf3g';
};

let getMockCoinToShuffle = function () {
	return {
		'amountSatoshis': 100000000, // 1 BCH
		'desc': 'mock coin'
	};
};

let getShuffleRoundObject = function (mockCommsChannel) {
	const ShuffleRound = require('../lib/ShuffleRound');

	return new ShuffleRound({
		coin: [ getMockCoinToShuffle() ],
		hooks: {
			change: getMockChangeAddress,
			shuffled: getMockShuffledCoinAddress
		},
		protocolVersion: 300,
		serverUri: 'http://localhost:8080/stats',
		poolAmount: 1000000,
		shuffleFee: 100
	}, mockCommsChannel);
};

test('When new ShuffleRound is created, then no errors are thrown.', function (t) {
	let shuffleRound = getShuffleRoundObject(getMockCommsChannel());
	t.truthy(shuffleRound);
});

test('When new ShuffleRound is created, subscribe to "serverMessage" event.', function (t) {
	let commsChannel = getMockCommsChannel();

	let shuffleRound = getShuffleRoundObject(commsChannel);

	t.truthy(_.isFunction(commsChannel.OnCallbacks['serverMessage']));
});

test('When new ShuffleRound is created, subscribe to "protocolViolation" event.', function (t) {
	let commsChannel = getMockCommsChannel();

	let shuffleRound = getShuffleRoundObject(commsChannel);

	t.truthy(_.isFunction(commsChannel.OnCallbacks['protocolViolation']));
});

test('When protocolViolation message is received, then blameMessage message is sent.', function (t) {
	let commsChannel = getMockCommsChannel();
	let shuffleRound = getShuffleRoundObject(commsChannel);

	commsChannel.resetSentMessages();

	commsChannel.OnCallbacks['protocolViolation']({'accused': 'TheFed', 'reason': 'inflation'}, true);

	let messageArgs = commsChannel.getLastSentMessageArgs();
	t.is('blameMessage', messageArgs[0])
});
