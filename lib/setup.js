'use strict';

const { FiveMoreMinutes, FmmError } = require('./client');

/**
 * Turns "192.168.1.10:5072" into "http://192.168.1.10:5072", which is what most people will type.
 * Anything else is left for the client to judge.
 *
 * @param {unknown} input
 */
function normalizeUrl(input) {
  const text = String(input ?? '').trim();
  if (text === '') return text;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
}

/**
 * Checks that an address and a key work, and says what they open. Nothing is stored here.
 *
 * @param {{ url: unknown, apiKey: unknown }} input
 * @param {{ createClient?: (options: { url: string, apiKey: string }) => FiveMoreMinutes }} [options]
 * @returns {Promise<{ computerId: string, name: string, scopes: string[], url: string, apiKey: string }>}
 */
async function validateSetup({ url, apiKey }, { createClient = (options) => new FiveMoreMinutes(options) } = {}) {
  const address = normalizeUrl(url);
  const key = String(apiKey ?? '').trim();

  // The client is the judge of what a good address and key look like, and never repeats the key.
  const client = createClient({ url: address, apiKey: key });
  const me = await client.me();

  if (!me.key.scopes.includes('state:read')) {
    throw new FmmError('forbidden', 'The key does not have the state:read permission, which this app needs to see the computer.');
  }

  return { computerId: me.device.id, name: me.device.name, scopes: me.key.scopes, url: address, apiKey: key };
}

module.exports = { validateSetup, normalizeUrl };
