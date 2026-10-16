'use strict';

const path = require('node:path');
const { createBrowseRunner } = require(path.join(__dirname, 'runtime', 'cpsLai3BrowseRunner.cjs'));

// This userDir is deliberately standalone and loopback-only. Do not add
// operational flows, MQTT brokers, credentials or automatic Inject nodes here.
module.exports = {
  uiHost: '127.0.0.1',
  uiPort: 1882,
  httpAdminRoot: false,
  httpNodeRoot: '/',
  flowFile: 'flows.json',
  flowFilePretty: true,
  contextStorage: {
    default: { module: 'memory' },
  },
  functionExternalModules: false,
  functionGlobalContext: {
    cpsLai3BrowseRunner: createBrowseRunner({
      userDir: __dirname,
      outputDir: path.join(__dirname, 'results'),
      stateFile: path.join(__dirname, 'runner-state.json'),
      // Empty by default. An operator must deliberately arm this process.
      armValue: process.env.CPSLAI3_BROWSE_ARM || '',
      // None/None is only a candidate; an exact explicit confirmation is required.
      securityMode: process.env.CPSLAI3_BROWSE_SECURITY_MODE || '',
      securityPolicy: process.env.CPSLAI3_BROWSE_SECURITY_POLICY || '',
      securityConfirmation: process.env.CPSLAI3_BROWSE_SECURITY_CONFIRMATION || '',
    }),
  },
};
