const _ = require('lodash');

class SanityChecker {
	static checkHooksAreAvailable (hooks) {
		if (!_.isFunction(hooks.change)) {
			debug(`A valid change generation hook was not provided!`);
			throw new Error('BAD_CHANGE_FN');
		}

		if (!_.isFunction(hooks.shuffled)) {
			debug(`A valid shuffle address generation hook was not provided!`);
			throw new Error('BAD_SHUFFLE_FN');
		}
	}
}

module.exports = SanityChecker;
