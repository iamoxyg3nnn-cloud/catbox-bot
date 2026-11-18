'use strict';

const { config } = require('../config');
const { DiscordStorage } = require('./discord');
const { MockStorage } = require('./mock');

let instance = null;

function getStorage() {
  if (instance) return instance;
  instance = config.discord.transport === 'mock'
    ? new MockStorage()
    : new DiscordStorage(config);
  return instance;
}

module.exports = { getStorage };
