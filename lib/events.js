'use strict';

// Adapted from fmm-plugin-template-node (src/events.js) as CommonJS. Pure: no I/O, no clock.
//
// Turns "the state now" and "the state before" into things that happened. Most plugins want events -
// "the time is up", "a timer started" - rather than a stream of snapshots, and getting the edges right
// is fiddly enough to write once and test.
//
// Pure: no I/O, no clock. Copy it with client.js.

/**
 * @typedef {import('./client.js').State} State
 * @typedef {'timer-started'|'timer-extended'|'timer-ended'|'lock-started'|'lock-ended'|'came-online'|'went-offline'} EventName
 */

/**
 * What changed between two states, as a list of event names in the order they make sense.
 * `previous` is null for the first state seen, which reports nothing: a plugin that has just
 * started has not watched anything happen, and pretending it has would fire "timer started" for
 * a timer that began an hour ago.
 *
 * @param {State | null} previous
 * @param {State} next
 * @returns {EventName[]}
 */
function eventsBetween(previous, next) {
  if (!previous) return [];

  /** @type {EventName[]} */
  const events = [];

  if (!previous.timer && next.timer) {
    events.push('timer-started');
  } else if (previous.timer && !next.timer) {
    events.push('timer-ended');
  } else if (previous.timer && next.timer) {
    // A different timer under the same name is a new one; the same one running longer is an extension.
    if (previous.timer.id !== next.timer.id) {
      events.push('timer-ended', 'timer-started');
    } else if (Date.parse(next.timer.endsAt) > Date.parse(previous.timer.endsAt)) {
      events.push('timer-extended');
    }
  }

  if (!previous.lock && next.lock) events.push('lock-started');
  if (previous.lock && !next.lock) events.push('lock-ended');

  if (!previous.device.online && next.device.online) events.push('came-online');
  if (previous.device.online && !next.device.online) events.push('went-offline');

  return events;
}

/**
 * A sentence for a person, for logs and notifications.
 * @param {State} state
 */
function describe(state) {
  const name = state.device.name;

  if (state.lock) return `${name} is locked for another ${minutes(state.lock.secondsLeft)}.`;
  if (state.timer) {
    const why = state.timer.message ? ` (${state.timer.message})` : '';
    return `${name} has ${minutes(state.timer.secondsLeft)} left${why}.`;
  }
  return `${name} has no timer running.`;
}

/** @param {number} seconds */
function minutes(seconds) {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const whole = Math.round(seconds / 60);
  return `${whole} minute${whole === 1 ? '' : 's'}`;
}

module.exports = { eventsBetween, describe };
