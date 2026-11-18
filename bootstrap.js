'use strict';

// This checkout sits inside a directory literally named "node_modules", which
// makes Node skip the adjacent dependency folder during normal resolution.
// Point NODE_PATH at it before any package is required.

const path = require('path');
const Module = require('module');

process.env.NODE_PATH = path.join(__dirname, 'node_modules');
Module._initPaths();
