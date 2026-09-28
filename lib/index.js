#!/usr/bin/env node

import { createBots } from './helpers.js';

/* istanbul ignore next */
if (!module.parent) {
  require('./cli').default();
}

export default createBots;
