'use strict';

// Just enough of the Homey runtime to load the app's own classes and drive them: the `homey` module
// (App, Driver, Device), and the `this.homey` object with translations and flow cards. It records what
// the app does so a test can say what happened. It is a stand-in, not a Homey: the real one is
// exercised by `homey app validate` and by installing the app.

const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const root = path.join(__dirname, '..');

function translations(language) {
  return JSON.parse(fs.readFileSync(path.join(root, 'locales', `${language}.json`), 'utf8'));
}

/** Looks a dotted key up in a locale, and fills {{name}} the way Homey does. Unknown keys come back as themselves. */
function translator(language) {
  const table = translations(language);
  return (key, values = {}) => {
    const found = key.split('.').reduce((node, part) => (node && typeof node === 'object' ? node[part] : undefined), table);
    if (typeof found !== 'string') return key;
    return found.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name) => String(values[name] ?? ''));
  };
}

function makeHomey(language = 'en') {
  const homey = {
    __: translator(language),
    triggers: [],
    conditions: new Map(),
    actions: new Map(),
    flow: {
      getDeviceTriggerCard: (id) => ({ trigger: async (device, tokens) => { homey.triggers.push({ id, device, tokens }); } }),
      getConditionCard: (id) => ({ registerRunListener: (listener) => { homey.conditions.set(id, listener); } }),
      getActionCard: (id) => ({ registerRunListener: (listener) => { homey.actions.set(id, listener); } }),
    },
  };
  return homey;
}

class App {
  constructor(homey) {
    this.homey = homey;
    this.log = () => {};
    this.error = () => {};
  }
}

class Driver {
  constructor(homey) {
    this.homey = homey;
    this.log = () => {};
    this.error = () => {};
  }
}

class Device {
  constructor(homey, { data = {}, store = {}, capabilities = [] } = {}) {
    this.homey = homey;
    this.log = () => {};
    this.error = () => {};
    this._data = data;
    this._store = { ...store };
    this._capabilities = new Map(capabilities.map((c) => [c, null]));
    this.availability = { available: true, message: null };
  }

  getData() { return this._data; }
  getStoreValue(key) { return this._store[key]; }
  async setStoreValue(key, value) { this._store[key] = value; }
  hasCapability(id) { return this._capabilities.has(id); }
  async addCapability(id) { this._capabilities.set(id, null); }
  async setCapabilityValue(id, value) { this._capabilities.set(id, value); }
  getCapabilityValue(id) { return this._capabilities.get(id); }
  async setAvailable() { this.availability = { available: true, message: null }; }
  async setUnavailable(message) { this.availability = { available: false, message }; }
}

const fake = { App, Driver, Device };

// `require('homey')` is provided by the Homey runtime; here it is provided by this file.
const load = Module._load;
Module._load = function patched(request, ...rest) {
  return request === 'homey' ? fake : load.call(this, request, ...rest);
};

module.exports = { makeHomey, Device };
