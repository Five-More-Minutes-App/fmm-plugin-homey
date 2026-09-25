import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { afterEach, describe, it } from 'node:test';
import { KEY, startMock } from './mock-fmm.mjs';

const require = createRequire(import.meta.url);
const { makeHomey } = require('./fake-homey.cjs');
const { registerFlowCards } = require('../lib/flow.js');
const ComputerDevice = require('../drivers/computer/device.js');
const ComputerDriver = require('../drivers/computer/driver.js');
const FiveMoreMinutesApp = require('../app.js');

const OTHER_KEY = `fmmk_${'e'.repeat(32)}_${'C'.repeat(43)}`;
const cleanups = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

async function until(check, what, timeoutMs = 4000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.fail(`timed out waiting for ${what}`);
}

const CAPS = ['fmm_online', 'fmm_timer_running', 'fmm_minutes_left', 'fmm_locked'];

/** A paired device, following a mock service, in a fake Homey speaking the given language. */
async function pairedDevice({ language = 'en', mockOptions, capabilities = CAPS } = {}) {
  const mock = await startMock(mockOptions);
  const homey = makeHomey(language);
  registerFlowCards(homey);

  const device = new ComputerDevice(homey, {
    data: { id: '11111111-1111-1111-1111-111111111111' },
    store: { url: mock.url, apiKey: KEY },
    capabilities,
  });
  cleanups.push(async () => { await device.onUninit(); await mock.close(); });
  await device.onInit();
  return { mock, homey, device };
}

/** Runs the driver's pairing handlers the way Homey's pair session would. */
function session() {
  const handlers = new Map();
  return {
    setHandler: (name, fn) => handlers.set(name, fn),
    call: (name, arg) => handlers.get(name)(arg),
    has: (name) => handlers.has(name),
  };
}

describe('the app', () => {
  it('registers every flow card the manifest declares', async () => {
    const homey = makeHomey();
    const app = new FiveMoreMinutesApp(homey);
    await app.onInit();

    const manifest = JSON.parse(readFileSync(new URL('../app.json', import.meta.url), 'utf8'));
    assert.deepEqual([...homey.conditions.keys()].sort(), manifest.flow.conditions.map((c) => c.id).sort());
    assert.deepEqual([...homey.actions.keys()].sort(), manifest.flow.actions.map((c) => c.id).sort());
  });
});

describe('pairing', () => {
  const pair = async (homey, mock) => {
    const driver = new ComputerDriver(homey);
    const s = session();
    await driver.onPair(s);
    return { driver, s };
  };

  it('connects with an address and a key, and offers the computer, keeping the key out of the settings', async () => {
    const mock = await startMock();
    cleanups.push(() => mock.close());
    const { s } = await pair(makeHomey(), mock);

    const answer = await s.call('connect', { url: mock.url, apiKey: KEY });
    const devices = await s.call('list_devices');

    assert.deepEqual(answer, { name: 'Elliots laptop' });
    assert.equal(devices.length, 1);
    assert.deepEqual(devices[0].data, { id: '11111111-1111-1111-1111-111111111111' });
    assert.deepEqual(devices[0].store, { url: mock.url, apiKey: KEY });
    assert.equal(devices[0].settings, undefined, 'nothing secret is a setting: settings are shown in the app');
    assert.ok(!JSON.stringify(devices[0].data).includes(KEY));
  });

  it('accepts an address typed without http://, and a key with stray spaces', async () => {
    const mock = await startMock();
    cleanups.push(() => mock.close());
    const { s } = await pair(makeHomey(), mock);

    await s.call('connect', { url: `  ${mock.url.replace('http://', '')} `, apiKey: `  ${KEY}\n` });

    assert.equal((await s.call('list_devices'))[0].store.url, mock.url);
    assert.equal((await s.call('list_devices'))[0].store.apiKey, KEY);
  });

  it('offers nothing until a connection has worked, and forgets it if the next attempt fails', async () => {
    const mock = await startMock();
    cleanups.push(() => mock.close());
    const { s } = await pair(makeHomey(), mock);

    assert.deepEqual(await s.call('list_devices'), []);
    await s.call('connect', { url: mock.url, apiKey: KEY });
    await assert.rejects(s.call('connect', { url: mock.url, apiKey: OTHER_KEY }));
    assert.deepEqual(await s.call('list_devices'), []);
  });

  it('says what is wrong in the user\'s language, and never repeats the key', async () => {
    const mock = await startMock();
    cleanups.push(() => mock.close());

    for (const [language, expected] of [['en', /not accepted/], ['sv', /godtogs inte/]]) {
      const { s } = await pair(makeHomey(language), mock);
      await assert.rejects(s.call('connect', { url: mock.url, apiKey: OTHER_KEY }), (e) => expected.test(e.message) && !e.message.includes(OTHER_KEY));
    }
  });

  it('explains a key that is not a key, an address that is not an address, and an unreachable service', async () => {
    const mock = await startMock();
    const { s } = await pair(makeHomey(), mock);

    await assert.rejects(s.call('connect', { url: mock.url, apiKey: 'nope' }), /cannot be used/);
    await assert.rejects(s.call('connect', { url: 'ftp://x', apiKey: KEY }), /cannot be used/);
    await mock.close();
    await assert.rejects(s.call('connect', { url: mock.url, apiKey: KEY }), /Could not reach/);
  });

  it('refuses a key that cannot see the computer, since the device would show nothing', async () => {
    const mock = await startMock({ scopes: ['timer:start'] });
    cleanups.push(() => mock.close());
    const { s } = await pair(makeHomey(), mock);

    await assert.rejects(s.call('connect', { url: mock.url, apiKey: KEY }), /permission/);
  });

  it('explains a service that only answers the local network', async () => {
    const mock = await startMock({ localOnly: true });
    cleanups.push(() => mock.close());
    const { s } = await pair(makeHomey(), mock);

    await assert.rejects(s.call('connect', { url: mock.url, apiKey: KEY }), /home network/);
  });
});

describe('repairing', () => {
  it('takes a new key for the same computer and reconnects', async () => {
    const { homey, device } = await pairedDevice({ mockOptions: { key: `fmmk_${'f'.repeat(32)}_${'B'.repeat(43)}` } });
    await until(() => !device.availability.available, 'the device to say it is unavailable');
    assert.match(device.availability.message, /not accepted/);

    // The parent makes a new key and enters it; here, a service that accepts KEY stands in for that.
    const good = await startMock();
    cleanups.push(() => good.close());
    const driver = new ComputerDriver(homey);
    const s = session();
    await driver.onRepair(s, device);

    await s.call('connect', { url: good.url, apiKey: KEY });

    assert.equal(device.getStoreValue('url'), good.url);
    assert.equal(device.getStoreValue('apiKey'), KEY);
    await until(() => device.availability.available && device.getCapabilityValue('fmm_online') === true, 'the device to come back');
  });

  it('refuses a key for a different computer, which would turn this device into that one', async () => {
    const { homey, device } = await pairedDevice();
    device._data = { id: '99999999-9999-9999-9999-999999999999' };
    const driver = new ComputerDriver(homey);
    const s = session();
    await driver.onRepair(s, device);
    const other = await startMock();
    cleanups.push(() => other.close());

    await assert.rejects(s.call('connect', { url: other.url, apiKey: KEY }), /different computer/);
    assert.notEqual(device.getStoreValue('url'), other.url);
  });
});

describe('the device', () => {
  it('shows what the computer is doing, and adds capabilities a newer version needs', async () => {
    const mock = await startMock();
    mock.parentStarts(30);
    const homey = makeHomey();
    const device = new ComputerDevice(homey, { data: { id: 'x' }, store: { url: mock.url, apiKey: KEY }, capabilities: ['fmm_online'] });
    cleanups.push(async () => { await device.onUninit(); await mock.close(); });

    await device.onInit();

    for (const c of CAPS) assert.ok(device.hasCapability(c), c);
    await until(() => device.getCapabilityValue('fmm_timer_running') === true, 'the timer to show');
    assert.equal(device.getCapabilityValue('fmm_online'), true);
    assert.ok(device.getCapabilityValue('fmm_minutes_left') >= 29);
  });

  it('fires flow triggers on the device when something happens', async () => {
    const { mock, homey, device } = await pairedDevice();
    await until(() => device.getCapabilityValue('fmm_online') === true, 'the first state');

    mock.parentStarts(15, 'Homework');

    await until(() => homey.triggers.length === 1, 'the trigger');
    assert.equal(homey.triggers[0].id, 'timer_started');
    assert.equal(homey.triggers[0].device, device);
    assert.deepEqual(homey.triggers[0].tokens, { minutes: 15, message: 'Homework' });
  });

  it('says why it is unavailable, in the user\'s language, when the key stops working', async () => {
    const { device } = await pairedDevice({ language: 'sv', mockOptions: { key: `fmmk_${'f'.repeat(32)}_${'B'.repeat(43)}` } });

    await until(() => !device.availability.available, 'unavailable');

    assert.match(device.availability.message, /godtogs inte/);
    assert.ok(!device.availability.message.includes(KEY));
  });

  it('says so when the stored key is not even a key', async () => {
    const homey = makeHomey();
    const device = new ComputerDevice(homey, { data: { id: 'x' }, store: { url: 'http://127.0.0.1:1', apiKey: 'garbage' }, capabilities: CAPS });

    await device.onInit();

    assert.equal(device.availability.available, false);
    assert.equal(device.controller, null);
  });

  it('stops following when it is deleted', async () => {
    const { mock, device } = await pairedDevice();
    await until(() => device.getCapabilityValue('fmm_online') === true, 'the first state');

    await device.onDeleted();
    const before = mock.world.requests.length;
    await new Promise((r) => setTimeout(r, 300));

    assert.equal(device.controller, null);
    assert.ok(mock.world.requests.length - before <= 1, 'at most the request that was already on its way');
  });
});

describe('flow cards', () => {
  it('conditions answer from what is known', async () => {
    const { mock, homey, device } = await pairedDevice();
    await until(() => device.getCapabilityValue('fmm_online') === true, 'the first state');

    assert.equal(await homey.conditions.get('timer_running')({ device }), false);
    mock.parentStarts(10);
    await until(() => device.getCapabilityValue('fmm_timer_running') === true, 'the timer');

    assert.equal(await homey.conditions.get('timer_running')({ device }), true);
    assert.equal(await homey.conditions.get('locked')({ device }), false);
    assert.equal(await homey.conditions.get('online')({ device }), true);
  });

  it('a condition on a device that has not heard from the computer is false, not an error', async () => {
    const homey = makeHomey();
    registerFlowCards(homey);
    const device = new ComputerDevice(homey, { data: { id: 'x' }, store: { url: 'http://127.0.0.1:1', apiKey: 'garbage' }, capabilities: CAPS });
    await device.onInit();

    assert.equal(await homey.conditions.get('online')({ device }), false);
  });

  it('actions do what they say', async () => {
    const { mock, homey, device } = await pairedDevice();
    await until(() => device.getCapabilityValue('fmm_online') === true, 'the first state');

    assert.equal(await homey.actions.get('start_timer')({ device, minutes: 20, message: 'Reading' }), true);
    assert.equal(mock.world.timer.message, 'Reading');

    await homey.actions.get('extend_timer')({ device, minutes: '' });
    await homey.actions.get('extend_timer')({ device, minutes: '10' });
    assert.deepEqual(mock.world.requests.filter((r) => r.path.endsWith('/extend')).map((r) => r.body), [{}, { minutes: 10 }]);

    await homey.actions.get('end_time')({ device });
    assert.ok(mock.world.lock);

    await homey.actions.get('start_until')({ device, until: '20:00' });
    assert.ok(mock.world.timer);
    await homey.actions.get('cancel_timer')({ device });
    assert.equal(mock.world.timer, null);
  });

  it('an action that cannot be done fails with a sentence in the user\'s language', async () => {
    const { mock, homey, device } = await pairedDevice({ language: 'sv' });
    await until(() => device.getCapabilityValue('fmm_online') === true, 'the first state');
    mock.parentStarts(10);
    await until(() => device.getCapabilityValue('fmm_timer_running') === true, 'the timer');

    await assert.rejects(homey.actions.get('start_timer')({ device, minutes: 5 }), /Går inte just nu/);
    await assert.rejects(homey.actions.get('start_timer')({ device, minutes: 0 }), /heltal/);
    await assert.rejects(homey.actions.get('start_until')({ device, until: 'soon' }), /20:00/);
  });

  it('an action on a permission the key lacks says so, and no error object escapes', async () => {
    const { homey, device } = await pairedDevice({ mockOptions: { scopes: ['state:read'] } });
    await until(() => device.getCapabilityValue('fmm_online') === true, 'the first state');

    const error = await homey.actions.get('start_timer')({ device, minutes: 5 }).catch((e) => e);

    assert.match(error.message, /permission/);
    assert.equal(error.cause, undefined);
    assert.ok(!error.message.includes(KEY));
  });

  it('an action on a device that is not connected says so', async () => {
    const homey = makeHomey();
    registerFlowCards(homey);
    const device = new ComputerDevice(homey, { data: { id: 'x' }, store: { url: 'http://127.0.0.1:1', apiKey: 'garbage' }, capabilities: CAPS });
    await device.onInit();

    await assert.rejects(homey.actions.get('end_time')({ device }), /not connected/);
  });
});
