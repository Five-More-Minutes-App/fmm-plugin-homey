'use strict';

const Homey = require('homey');
const { registerFlowCards } = require('./lib/flow');

class FiveMoreMinutesApp extends Homey.App {
  async onInit() {
    registerFlowCards(this.homey);
    this.log('Five More Minutes has started');
  }
}

module.exports = FiveMoreMinutesApp;
