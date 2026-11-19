'use strict';

// Small in-memory operator switches. These are intentionally process-local:
// they control live traffic until the next restart, while durable settings stay
// in the environment (see README / GitHub Secrets).

const flags = {
  uploadsPaused: false,
};

function get() {
  return { ...flags };
}

function set(patch = {}) {
  if (typeof patch.uploadsPaused === 'boolean') flags.uploadsPaused = patch.uploadsPaused;
  return get();
}

module.exports = { get, set };
