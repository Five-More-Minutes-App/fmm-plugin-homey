'use strict';

const Homey = require('homey');
const { FiveMoreMinutes } = require('../../lib/client');
const { ComputerController } = require('../../lib/controller');
const { describeError } = require('../../lib/errors');

const CAPABILITIES = ['fmm_online', 'fmm_timer_running', 'fmm_minutes_left', 'fmm_locked'];

class ComputerDevice extends Homey.Device {
  /** @type {ComputerController | null} */
  controller = null;

  async onInit() {
    // A newer version of the app may have more to show than the device was made with.
    for (const capability of CAPABILITIES) {
      if (!this.hasCapability(capability)) await this.addCapability(capability);
    }

    await this.#connect();
  }

  async onUninit() {
    await this.#disconnect();
  }

  async onDeleted() {
    await this.#disconnect();
  }

  /** Starts again with what is stored now, for when the address or key has been repaired. */
  async reconnect() {
    await this.#disconnect();
    await this.#connect();
  }

  async #connect() {
    let client;
    try {
      client = new FiveMoreMinutes({ url: this.getStoreValue('url'), apiKey: this.getStoreValue('apiKey') });
    } catch (error) {
      await this.setUnavailable(this.#say(error));
      return;
    }

    // Homey remembers a device as unavailable across restarts and repairs; start from a clean slate,
    // and the controller says so again straight away if the computer really cannot be reached.
    await this.setAvailable();

    this.controller = new ComputerController({
      client,
      host: {
        set: (values) => Promise.all(Object.entries(values).map(([capability, value]) => this.setCapabilityValue(capability, value).catch(this.error))),
        trigger: (card, tokens) => this.homey.flow.getDeviceTriggerCard(card).trigger(this, tokens),
        available: () => this.setAvailable(),
        unavailable: (error) => this.setUnavailable(this.#say(error)),
        log: (message) => this.log(message),
      },
    });

    // Not awaited: the device is ready now, and fills in as soon as the computer has answered.
    this.controller.follow();
  }

  async #disconnect() {
    const controller = this.controller;
    this.controller = null;
    await controller?.unfollow();
  }

  /** @param {unknown} error */
  #say(error) {
    return describeError(error, (key, values) => this.homey.__(key, values));
  }
}

module.exports = ComputerDevice;
