'use strict';

const Homey = require('homey');
const { describeError } = require('../../lib/errors');
const { validateSetup } = require('../../lib/setup');

class ComputerDriver extends Homey.Driver {
  async onPair(session) {
    /** @type {Awaited<ReturnType<typeof validateSetup>> | null} */
    let found = null;

    // The page asks to connect; the answer is either the computer's name or a sentence to show.
    session.setHandler('connect', async ({ url, apiKey }) => {
      found = null;
      try {
        found = await validateSetup({ url, apiKey });
      } catch (error) {
        throw new Error(this.#say(error));
      }
      return { name: found.name };
    });

    session.setHandler('list_devices', async () => {
      if (!found) return [];
      return [{
        name: found.name,
        // One device per computer: pairing the same computer twice is refused by Homey itself.
        data: { id: found.computerId },
        // Not settings, so the key is never shown in the app. Homey keeps it on the Homey.
        store: { url: found.url, apiKey: found.apiKey },
      }];
    });
  }

  /** For a key that was revoked or has expired: enter a new one without removing the device. */
  async onRepair(session, device) {
    session.setHandler('connect', async ({ url, apiKey }) => {
      let found;
      try {
        found = await validateSetup({ url, apiKey });
      } catch (error) {
        throw new Error(this.#say(error));
      }

      // A key for another computer would silently turn this device into that one.
      if (found.computerId !== device.getData().id) throw new Error(this.homey.__('errors.wrongComputer', { name: found.name }));

      await device.setStoreValue('url', found.url);
      await device.setStoreValue('apiKey', found.apiKey);
      await device.reconnect();
      return { name: found.name };
    });
  }

  /** @param {unknown} error */
  #say(error) {
    return describeError(error, (key, values) => this.homey.__(key, values));
  }
}

module.exports = ComputerDriver;
