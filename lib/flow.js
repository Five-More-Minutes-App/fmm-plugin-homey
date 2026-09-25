'use strict';

const { capabilityValues } = require('./controller');
const { describeError } = require('./errors');

/**
 * Runs an action on a device, and turns a failure into a sentence the flow can show, in the user's language.
 *
 * @param {any} homey
 * @param {any} device
 * @param {(controller: import('./controller').ComputerController) => Promise<unknown>} action
 */
async function run(homey, device, action) {
  const t = (/** @type {string} */ key, /** @type {any} */ values) => homey.__(key, values);

  if (!device.controller) throw new Error(t('errors.unavailable'));

  try {
    await action(device.controller);
  } catch (error) {
    // Only the sentence is passed on, never the error itself: nothing in it is meant for a flow.
    throw new Error(describeError(error, t));
  }
  return true;
}

/**
 * Registers what a flow can do with a computer. Called once, when the app starts.
 *
 * @param {any} homey
 * @param {() => number} [now]
 */
function registerFlowCards(homey, now = Date.now) {
  const { flow } = homey;

  // Conditions read what is known now; they never call the service.
  const condition = (/** @type {string} */ id, /** @type {string} */ capability) => flow.getConditionCard(id).registerRunListener(async ({ device }) => {
    const state = device.controller?.state;
    return state ? Boolean(capabilityValues(state, now())[capability]) : false;
  });

  condition('timer_running', 'fmm_timer_running');
  condition('locked', 'fmm_locked');
  condition('online', 'fmm_online');

  flow.getActionCard('start_timer').registerRunListener(({ device, minutes, message }) => run(homey, device, (c) => c.startTimer({ minutes, message })));
  flow.getActionCard('start_until').registerRunListener(({ device, until, message }) => run(homey, device, (c) => c.startUntil({ until, message })));
  flow.getActionCard('extend_timer').registerRunListener(({ device, minutes }) => run(homey, device, (c) => c.extend(minutes === '' ? undefined : minutes)));
  flow.getActionCard('end_time').registerRunListener(({ device }) => run(homey, device, (c) => c.endTime()));
  flow.getActionCard('cancel_timer').registerRunListener(({ device }) => run(homey, device, (c) => c.cancel()));
}

module.exports = { registerFlowCards };
