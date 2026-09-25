import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { afterEach, describe, it } from 'node:test';
import { KEY, startMock } from './mock-fmm.mjs';

const require = createRequire(import.meta.url);
const { FiveMoreMinutes } = require('../lib/client.js');
const { ComputerController, ArgumentError, capabilityValues, TRIGGERS } = require('../lib/controller.js');

const cleanups = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

/** A stand-in for the Homey device: it records what it was asked to do. */
function fakeHost({ failTrigger = false } = {}) {
  const host = {
    values: {},
    sets: [],
    triggers: [],
    unavailableErrors: [],
    availableCalls: 0,
    logs: [],
    set(values) { host.sets.push(values); Object.assign(host.values, values); },
    trigger(card, tokens) { if (failTrigger) throw new Error('flow failed'); host.triggers.push({ card, tokens }); },
    available() { host.availableCalls += 1; },
    unavailable(error) { host.unavailableErrors.push(error); },
    log(message) { host.logs.push(message); },
  };
  return host;
}

async function setup({ mockOptions, hostOptions, controllerOptions = {} } = {}) {
  const mock = await startMock(mockOptions);
  const host = fakeHost(hostOptions);
  const client = new FiveMoreMinutes({ url: mock.url, apiKey: KEY, timeoutMs: 2000 });
  const controller = new ComputerController({ client, host, retry: { minMs: 30, maxMs: 100 }, waitSeconds: 1, tickMs: 60_000, ...controllerOptions });
  cleanups.push(async () => { await controller.unfollow(); await mock.close(); });
  return { mock, host, controller, client };
}

async function until(check, what, timeoutMs = 4000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.fail(`timed out waiting for ${what}`);
}

describe('following a computer', () => {
  it('shows the state as soon as it has it, and fires nothing for what it did not see happen', async () => {
    const t = await setup();
    t.mock.parentStarts(30, 'Homework');

    await t.controller.follow();

    assert.equal(t.host.values.fmm_timer_running, true);
    assert.equal(t.host.values.fmm_locked, false);
    assert.equal(t.host.values.fmm_online, true);
    assert.ok(t.host.values.fmm_minutes_left >= 29 && t.host.values.fmm_minutes_left <= 30);
    assert.deepEqual(t.host.triggers, [], 'a timer that was already running is not "started"');
  });

  it('fires the right trigger, with tokens, when a timer starts', async () => {
    const t = await setup();
    await t.controller.follow();

    t.mock.parentStarts(30, 'Homework');

    await until(() => t.host.triggers.length === 1, 'the trigger');
    assert.deepEqual(t.host.triggers[0], { card: 'timer_started', tokens: { minutes: 30, message: 'Homework' } });
    assert.equal(t.host.values.fmm_timer_running, true);
  });

  it('fires for extension, end, lock, unlock, offline and online, in that sense', async () => {
    const t = await setup();
    t.mock.parentStarts(10);
    await t.controller.follow();

    t.mock.world.timer.endsAt = new Date(Date.parse(t.mock.world.timer.endsAt) + 5 * 60_000).toISOString();
    t.mock.setOnline(false);
    await until(() => t.host.triggers.some((x) => x.card === 'timer_extended') && t.host.triggers.some((x) => x.card === 'went_offline'), 'extension and offline');

    t.mock.setOnline(true);
    await until(() => t.host.triggers.some((x) => x.card === 'came_online'), 'online');

    t.mock.parentLocks(20);
    await until(() => t.host.triggers.some((x) => x.card === 'locked'), 'lock');
    assert.ok(t.host.triggers.some((x) => x.card === 'timer_ended'));
    assert.deepEqual(t.host.triggers.find((x) => x.card === 'locked').tokens, { minutes: 20 });
    assert.equal(t.host.values.fmm_locked, true);
    assert.equal(t.host.values.fmm_timer_running, false);

    t.mock.parentLifts();
    await until(() => t.host.triggers.some((x) => x.card === 'unlocked'), 'unlock');
    assert.equal(t.host.values.fmm_locked, false);
  });

  it('has a flow trigger for every event the helper can report', () => {
    assert.deepEqual(Object.keys(TRIGGERS).sort(), ['came-online', 'lock-ended', 'lock-started', 'timer-ended', 'timer-extended', 'timer-started', 'went-offline']);
  });

  it('asks to be answered when a timer is about to end, so the end is noticed then', async () => {
    const t = await setup({ controllerOptions: { waitSeconds: 25 } });
    t.mock.parentStarts(5);
    t.mock.world.timer.endsAt = new Date(Date.now() + 3000).toISOString(); // ends in three seconds
    await t.controller.follow();

    await until(() => t.mock.world.requests.filter((r) => r.path.endsWith('/state')).length >= 2, 'the second poll');

    const wait = Number(t.mock.world.requests.filter((r) => r.path.endsWith('/state'))[1].query.wait);
    assert.ok(wait <= 5, `waited up to ${wait}s though the timer ends in 3`);
  });

  it('keeps the minutes left honest between polls', async () => {
    let now = Date.now();
    const t = await setup({ controllerOptions: { now: () => now, tickMs: 20 } });
    t.mock.parentStarts(10);
    await t.controller.follow();
    const before = t.host.values.fmm_minutes_left;

    now += 3 * 60_000;
    await until(() => t.host.values.fmm_minutes_left < before, 'the tick');

    assert.equal(t.host.values.fmm_minutes_left, before - 3);
  });
});

describe('when things go wrong', () => {
  it('says unavailable after a few failures, and available again, and reports what it missed', async () => {
    const t = await setup();
    t.mock.parentStarts(1);
    await t.controller.follow();

    t.mock.world.failNext = 1000;
    await until(() => t.host.unavailableErrors.length >= 1, 'unavailable');
    assert.equal(t.host.unavailableErrors[0].kind, 'unexpected');

    // While it was out of reach, the timer ended and a lock began.
    t.mock.world.timer = null;
    t.mock.world.lock = { startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + 600_000).toISOString(), mode: 'Network' };
    t.mock.world.failNext = 0;

    await until(() => t.host.availableCalls === 1, 'available again');
    await until(() => t.host.triggers.some((x) => x.card === 'locked'), 'the missed lock');
    assert.ok(t.host.triggers.some((x) => x.card === 'timer_ended'));
  });

  it('does not say unavailable for one hiccup', async () => {
    const t = await setup();
    await t.controller.follow();

    t.mock.world.failNext = 1;
    t.mock.parentStarts(5);
    await until(() => t.host.triggers.length === 1, 'the trigger after a retry');

    assert.deepEqual(t.host.unavailableErrors, []);
  });

  it('stops asking, once, when the key is refused', async () => {
    const t = await setup({ mockOptions: { key: `fmmk_${'f'.repeat(32)}_${'B'.repeat(43)}` } });

    await t.controller.follow();

    assert.equal(t.host.unavailableErrors.length, 1);
    assert.equal(t.host.unavailableErrors[0].kind, 'auth');
    const requests = t.mock.world.requests.length;
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(t.mock.world.requests.length, requests, 'a refused key is not tried again');
  });

  it('keeps following when a flow fails', async () => {
    const t = await setup({ hostOptions: { failTrigger: true } });
    await t.controller.follow();

    t.mock.parentStarts(5);
    await until(() => t.host.values.fmm_timer_running === true, 'the state to be shown');
    t.mock.world.timer = null; t.mock.parentLocks(5);
    await until(() => t.host.values.fmm_locked === true, 'the next state too');

    assert.ok(t.host.logs.some((l) => /Could not run flows/.test(l)));
  });

  it('stops when told to, and does not touch the host afterwards', async () => {
    const t = await setup();
    await t.controller.follow();
    await t.controller.unfollow();
    const count = t.host.sets.length;

    t.mock.parentStarts(5);
    await new Promise((r) => setTimeout(r, 200));

    assert.equal(t.host.sets.length, count);
  });

  it('never puts the key in anything it logs or hands to the host', async () => {
    const t = await setup({ mockOptions: { key: `fmmk_${'f'.repeat(32)}_${'B'.repeat(43)}` } });
    await t.controller.follow();

    const text = JSON.stringify({ logs: t.host.logs, un: t.host.unavailableErrors.map((e) => e.message) });
    assert.ok(!text.includes(KEY));
  });
});

describe('actions', () => {
  it('starts a timer, and shows it and fires the trigger without waiting for the next poll', async () => {
    const t = await setup();
    await t.controller.follow();

    const state = await t.controller.startTimer({ minutes: 25, message: 'Reading' });

    assert.equal(state.timer.message, 'Reading');
    assert.equal(t.host.values.fmm_timer_running, true);
    await until(() => t.host.triggers.length >= 1, 'trigger');
    assert.equal(t.host.triggers.filter((x) => x.card === 'timer_started').length, 1, 'once, not once for the action and once for the poll');
  });

  it('adds time, with or without saying how much', async () => {
    const t = await setup();
    t.mock.parentStarts(10);
    await t.controller.follow();

    await t.controller.extend(7);
    await t.controller.extend();

    const bodies = t.mock.world.requests.filter((r) => r.path.endsWith('/timer/extend')).map((r) => r.body);
    assert.deepEqual(bodies, [{ minutes: 7 }, {}]);
  });

  it('ends time (locking) and cancels (not locking)', async () => {
    const t = await setup();
    t.mock.parentStarts(10);
    await t.controller.follow();

    await t.controller.endTime();
    assert.equal(t.host.values.fmm_locked, true);

    t.mock.parentStarts(10);
    await until(() => t.host.values.fmm_timer_running === true, 'the new timer');
    await t.controller.cancel();
    assert.equal(t.host.values.fmm_timer_running, false);
    assert.equal(t.host.values.fmm_locked, false);
  });

  it('starts until a clock time, padding a single-digit hour', async () => {
    const t = await setup();
    await t.controller.follow();

    await t.controller.startUntil({ until: ' 9:05 ' });

    assert.equal(t.mock.world.requests.find((r) => r.path.endsWith('/timer/start')).body.until, '09:05');
  });

  it('refuses minutes that make no sense, before asking the service', async () => {
    const t = await setup();
    await t.controller.follow();

    for (const minutes of [0, -5, 1441, 2.5, 'abc', NaN, null, undefined, Infinity]) {
      await assert.rejects(t.controller.startTimer({ minutes }), (e) => e instanceof ArgumentError && e.key === 'errors.minutes', String(minutes));
    }
    await assert.rejects(t.controller.extend(0), ArgumentError);
    assert.equal(t.mock.world.requests.filter((r) => r.path.includes('/timer/')).length, 0);
  });

  it('accepts minutes given as text, which is what a flow gives', async () => {
    const t = await setup();
    await t.controller.follow();

    await t.controller.startTimer({ minutes: '15' });

    assert.equal(t.mock.world.requests.find((r) => r.path.endsWith('/timer/start')).body.minutes, 15);
  });

  it('refuses a time that is not a time', async () => {
    const t = await setup();
    await t.controller.follow();

    for (const until of ['', '25:00', '20:60', 'soon', '20', '20:0', '8pm', undefined]) {
      await assert.rejects(t.controller.startUntil({ until }), (e) => e instanceof ArgumentError && e.key === 'errors.until', String(until));
    }
  });

  it('cleans the message: no markup, no control characters, not too long, and none at all if it is empty', async () => {
    const t = await setup();
    await t.controller.follow();

    await t.controller.startTimer({ minutes: 5, message: `<b>Hi</b>\u0007 ${'x'.repeat(300)}` });
    await t.controller.cancel();
    await t.controller.startTimer({ minutes: 5, message: '   ' });

    const bodies = t.mock.world.requests.filter((r) => r.path.endsWith('/timer/start')).map((r) => r.body);
    assert.ok(bodies[0].message.length <= 100);
    assert.ok(!/[<>\u0000-\u001f]/.test(bodies[0].message));
    assert.equal(bodies[1].message, undefined);
  });

  it('passes on what the service says when it is not possible', async () => {
    const t = await setup();
    t.mock.parentStarts(10);
    await t.controller.follow();

    await assert.rejects(t.controller.startTimer({ minutes: 5 }), (e) => e.kind === 'not-possible' && /already running/.test(e.message));
  });

  it('passes on a missing permission', async () => {
    const t = await setup({ mockOptions: { scopes: ['state:read'] } });
    await t.controller.follow();

    await assert.rejects(t.controller.startTimer({ minutes: 5 }), (e) => e.kind === 'forbidden' && /timer:start/.test(e.message));
  });
});

describe('capabilityValues', () => {
  const state = (over = {}) => ({
    apiVersion: 1, serverTime: '', signal: 1, device: { id: 'd', name: 'x', online: true }, timer: null, lock: null, ...over,
  });
  const NOW = Date.parse('2026-09-25T18:00:00Z');
  const at = (s) => new Date(NOW + s * 1000).toISOString();

  it('rounds minutes left up, so "0 minutes" never shows while time is left', () => {
    const v = capabilityValues(state({ timer: { id: 't', startsAt: at(-60), endsAt: at(61), secondsLeft: 61, message: null } }), NOW);
    assert.equal(v.fmm_minutes_left, 2);
    assert.equal(capabilityValues(state({ timer: { id: 't', startsAt: at(-60), endsAt: at(1), secondsLeft: 1, message: null } }), NOW).fmm_minutes_left, 1);
  });

  it('treats a timer or lock whose end has passed as over, even before the service says so', () => {
    const v = capabilityValues(state({
      timer: { id: 't', startsAt: at(-600), endsAt: at(-1), secondsLeft: 0, message: null },
      lock: { startsAt: at(-600), endsAt: at(-1), secondsLeft: 0, mode: 'Network' },
    }), NOW);
    assert.deepEqual(v, { fmm_timer_running: false, fmm_locked: false, fmm_minutes_left: 0, fmm_online: true });
  });

  it('reports offline', () => {
    assert.equal(capabilityValues(state({ device: { id: 'd', name: 'x', online: false } }), NOW).fmm_online, false);
  });
});
