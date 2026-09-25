'use strict';

const { FmmError } = require('./client');
const { ArgumentError } = require('./controller');

const MESSAGES = Object.freeze({
  config: 'errors.config',
  auth: 'errors.auth',
  'network-only': 'errors.networkOnly',
  forbidden: 'errors.forbidden',
  'not-possible': 'errors.notPossible',
  invalid: 'errors.invalid',
  'rate-limited': 'errors.rateLimited',
  network: 'errors.network',
  unexpected: 'errors.unexpected',
});

/**
 * A sentence a person can act on, in their language, for whatever went wrong.
 *
 * Nothing here can contain the API key: the client never puts it in an error, and only the client's
 * own words, the kind of error, and a reason the service gave are used.
 *
 * @param {unknown} error
 * @param {(key: string, values?: Record<string, string | number>) => string} t Homey's `__`
 */
function describeError(error, t) {
  if (error instanceof ArgumentError) return t(error.key, error.values);

  if (error instanceof FmmError) {
    const key = MESSAGES[error.kind] ?? MESSAGES.unexpected;
    // The service's own reason is the useful part when something is not possible right now.
    return t(key, { reason: error.message });
  }

  return t(MESSAGES.unexpected, { reason: '' });
}

module.exports = { describeError };
