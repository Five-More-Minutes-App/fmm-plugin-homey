'use strict';

// Follows one computer in Five More Minutes and turns what happens to it into what a Homey device
// needs: capability values, flow triggers, and the actions a flow can take.
//
// It knows nothing about Homey. It is given a `host` with the few things it may ask of the device
// (set values, fire a trigger, say available / unavailable), which keeps the interesting part of the
// app - when things fire, and what happens when the network drops - testable without a Homey.

const { FmmError } = require('./client');
const { eventsBetween } = require('./events');

/** Which flow trigger each event fires. */
const TRIGGERS = Object.freeze({
  'timer-started': 'timer_started',
  'timer-extended': 'timer_extended',
  'timer-ended': 'timer_ended',
  'lock-started': 'locked',
  'lock-ended': 'unlocked',
  'came-online': 'came_online',
  'went-offline': 'went_offline',
});

/** A flow gave an action something that cannot be used. `key` is the name of the message to show. */
class ArgumentError extends Error {
  /**
   * @param {string} key
   * @param {Record<string, string | number>} [values]
   */
  constructor(key, values = {}) {
    super(key);
    this.name = 'ArgumentError';
    this.key = key;
    this.values = values;
  }
}

/**
 * What the device shows, from what the computer is doing.
 *
 * @param {import('./client').State} state
 * @param {number} now
 */
function capabilityValues(state, now) {
  const timerEnds = state.timer ? Date.parse(state.timer.endsAt) : 0;
  const lockEnds = state.lock ? Date.parse(state.lock.endsAt) : 0;
  const running = timerEnds > now;

  return {
    fmm_timer_running: running,
    fmm_locked: lockEnds > now,
    fmm_minutes_left: running ? Math.ceil((timerEnds - now) / 60_000) : 0,
    fmm_online: state.device.online,
  };
}

/**
 * The values a flow card can use from an event.
 *
 * @param {string} event
 * @param {import('./client').State} state
 * @returns {Record<string, string | number>}
 */
function tokensFor(event, state) {
  const wholeMinutes = (/** @type {string} */ from, /** @type {string} */ to) => Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 60_000));

  switch (event) {
    case 'timer-started':
      return { minutes: wholeMinutes(state.timer.startsAt, state.timer.endsAt), message: state.timer.message ?? '' };
    case 'timer-extended':
      return { minutes: Math.ceil(state.timer.secondsLeft / 60) };
    case 'lock-started':
      return { minutes: wholeMinutes(state.lock.startsAt, state.lock.endsAt) };
    default:
      return {};
  }
}

class ComputerController {
  #client;
  #host;
  #now;
  #retry;
  #waitSeconds;
  #tickMs;
  #unavailableAfter;

  /** @type {import('./client').State | null} */
  #state = null;
  #abort = new AbortController();
  #following = null;
  #available = true;
  #ticker = null;

  /**
   * @param {{
   *   client: import('./client').FiveMoreMinutes,
   *   host: {
   *     set: (values: Record<string, boolean | number>) => Promise<unknown> | unknown,
   *     trigger: (card: string, tokens: Record<string, string | number>) => Promise<unknown> | unknown,
   *     available: () => Promise<unknown> | unknown,
   *     unavailable: (error: unknown) => Promise<unknown> | unknown,
   *     log?: (message: string) => void,
   *   },
   *   now?: () => number,
   *   retry?: { minMs: number, maxMs: number },
   *   waitSeconds?: number,
   *   tickMs?: number,
   *   unavailableAfter?: number,
   * }} options
   */
  constructor({ client, host, now = Date.now, retry = { minMs: 2_000, maxMs: 60_000 }, waitSeconds = 25, tickMs = 30_000, unavailableAfter = 3 }) {
    this.#client = client;
    this.#host = host;
    this.#now = now;
    this.#retry = retry;
    this.#waitSeconds = waitSeconds;
    this.#tickMs = tickMs;
    this.#unavailableAfter = unavailableAfter;
  }

  /** The last state seen, or null before the first. */
  get state() {
    return this.#state;
  }

  /** Starts following. Resolves when the first state has been applied (or the first try has failed). */
  follow() {
    let firstAnswer;
    const first = new Promise((resolve) => { firstAnswer = resolve; });

    this.#following = this.#run(firstAnswer);
    this.#ticker = setInterval(() => this.#tick(), this.#tickMs);
    this.#ticker.unref?.();

    return first;
  }

  /** Stops following and waits until it has. */
  async unfollow() {
    this.#abort.abort();
    if (this.#ticker) clearInterval(this.#ticker);
    await this.#following;
  }

  // -- Actions --------------------------------------------------------------------------------

  /** @param {{ minutes: number, message?: string }} options */
  async startTimer({ minutes, message }) {
    return this.#do(() => this.#client.start({ minutes: whole(minutes), message: cleanMessage(message) }));
  }

  /** @param {{ until: string, message?: string }} options */
  async startUntil({ until, message }) {
    const text = String(until ?? '').trim();
    if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(text)) throw new ArgumentError('errors.until');
    return this.#do(() => this.#client.start({ until: text.padStart(5, '0'), message: cleanMessage(message) }));
  }

  /** @param {number} [minutes] Omit for the household's usual "five more minutes". */
  async extend(minutes) {
    return this.#do(() => this.#client.extend(minutes === undefined || minutes === null ? undefined : whole(minutes)));
  }

  async endTime() {
    return this.#do(() => this.#client.stop());
  }

  async cancel() {
    return this.#do(() => this.#client.cancel());
  }

  // -------------------------------------------------------------------------------------------

  /** @param {() => Promise<import('./client').State>} action */
  async #do(action) {
    const state = await action();
    // The answer is the state after the action, so what the device shows does not wait for the next poll.
    await this.#apply(state);
    return state;
  }

  /** @param {(state: import('./client').State) => void} [firstAnswer] */
  async #run(firstAnswer) {
    const { signal } = this.#abort;
    let since;
    let delay = this.#retry.minMs;
    let failures = 0;

    while (!signal.aborted) {
      try {
        const state = await this.#client.state({ wait: this.#waitFor(), since, signal });
        since = state.signal;
        delay = this.#retry.minMs;
        failures = 0;
        await this.#apply(state);
        firstAnswer?.();
        firstAnswer = undefined;
      } catch (error) {
        if (signal.aborted) break;

        failures += 1;
        this.#host.log?.(`Five More Minutes: ${error instanceof Error ? error.message : 'unknown error'}`);

        // A key that is refused will be refused again: say so, and stop asking.
        const fatal = error instanceof FmmError && !error.retryable;
        if (fatal || failures >= this.#unavailableAfter) {
          this.#available = false;
          await this.#host.unavailable(error);
        }
        firstAnswer?.();
        firstAnswer = undefined;
        if (fatal) break;

        const wait = error instanceof FmmError && error.retryAfter ? error.retryAfter * 1000 : delay;
        await sleep(wait, signal);
        delay = Math.min(delay * 2, this.#retry.maxMs);
      }
    }
  }

  /**
   * Asks to be answered when the timer or lock is about to end, so its end is noticed then and not
   * at the end of a long wait.
   */
  #waitFor() {
    const state = this.#state;
    const now = this.#now();
    const ends = [state?.timer?.endsAt, state?.lock?.endsAt]
      .map((at) => (at ? Date.parse(at) : 0))
      .filter((at) => at > now);

    if (ends.length === 0) return this.#waitSeconds;
    const untilNext = Math.ceil((Math.min(...ends) - now) / 1000) + 1;
    return Math.max(1, Math.min(this.#waitSeconds, untilNext));
  }

  /** @param {import('./client').State} state */
  async #apply(state) {
    const previous = this.#state;
    this.#state = state;

    if (!this.#available) {
      this.#available = true;
      await this.#host.available();
    }

    await this.#host.set(capabilityValues(state, this.#now()));

    for (const event of eventsBetween(previous, state)) {
      try {
        await this.#host.trigger(TRIGGERS[event], tokensFor(event, state));
      } catch (error) {
        // A flow that fails must not stop the device following the computer.
        this.#host.log?.(`Could not run flows for ${event}: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
    }
  }

  /** Keeps the minutes left honest between polls. */
  #tick() {
    if (this.#state && this.#available) {
      Promise.resolve(this.#host.set(capabilityValues(this.#state, this.#now()))).catch(() => {});
    }
  }
}

/** @param {unknown} value */
function whole(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 1440) throw new ArgumentError('errors.minutes');
  return number;
}

/** @param {unknown} message */
function cleanMessage(message) {
  if (typeof message !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex
  const text = message.replace(/[\u0000-\u001f\u007f<>]/g, ' ').trim().slice(0, 100);
  return text === '' ? undefined : text;
}

/**
 * @param {number} ms
 * @param {AbortSignal} signal
 */
function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}

module.exports = { ComputerController, ArgumentError, capabilityValues, tokensFor, TRIGGERS };
