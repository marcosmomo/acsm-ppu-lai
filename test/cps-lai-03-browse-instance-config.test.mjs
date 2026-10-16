import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const instance = path.join(root, 'node-red', 'lai', 'cpslai3-browse-instance');
const require = createRequire(import.meta.url);

test('isolated userDir flow is valid, core-only, and has no automatic trigger or OPC UA node', () => {
  const flow = JSON.parse(fs.readFileSync(path.join(instance, 'flows.json'), 'utf8'));
  const nodeTypes = new Set(['tab', 'http in', 'function', 'http response']);
  assert.equal(flow.filter(node => node.type === 'tab').length, 1);
  for (const node of flow) {
    assert.ok(nodeTypes.has(node.type), `unexpected node type ${node.type}`);
    if (node.type === 'function') assert.doesNotThrow(() => new Function('msg', 'node', 'global', node.func));
    for (const destinations of node.wires || []) for (const id of destinations) assert.ok(flow.some(candidate => candidate.id === id));
  }
  assert.equal(flow.some(node => node.type === 'inject' || /opcua|mqtt|e-mail/i.test(node.type)), false);
  assert.deepEqual(flow.filter(node => node.type === 'http in').map(node => `${node.method.toUpperCase()} ${node.url}`).sort(), [
    'GET /api/cpslai3-browse/result',
    'GET /api/cpslai3-browse/status',
    'GET /cpslai3-browse',
    'POST /api/cpslai3-browse/cancel',
    'POST /api/cpslai3-browse/release',
    'POST /api/cpslai3-browse/start',
  ]);
});

test('settings isolate port, listener, flows, context, safety journal and runner; no credentials are copied', () => {
  const settingsPath = path.join(instance, 'settings.js');
  const settingsSource = fs.readFileSync(settingsPath, 'utf8');
  const settings = require(settingsPath);
  assert.equal(settings.uiHost, '127.0.0.1');
  assert.equal(settings.uiPort, 1882);
  assert.equal(settings.httpAdminRoot, false);
  assert.equal(settings.flowFile, 'flows.json');
  assert.equal(path.resolve(instance, settings.flowFile), path.join(instance, 'flows.json'));
  assert.match(settingsSource, /stateFile: path\.join\(__dirname, 'runner-state\.json'\)/);
  assert.match(settingsSource, /CPSLAI3_BROWSE_SECURITY_MODE/);
  assert.match(settingsSource, /CPSLAI3_BROWSE_SECURITY_POLICY/);
  assert.match(settingsSource, /CPSLAI3_BROWSE_SECURITY_CONFIRMATION/);
  assert.equal(settings.contextStorage.default.module, 'memory');
  assert.equal(settings.functionExternalModules, false);
  assert.equal(settings.functionGlobalContext.cpsLai3BrowseRunner.getStatus().armed, false);
  assert.doesNotMatch(settingsSource, /flows_cred|credentialSecret|OpcUa-Client|OpcUa-Browser/i);
  assert.doesNotMatch(settingsSource.replace(/\/\/.*$/gm, ''), /mqtt|opcua/i);
  assert.equal(fs.existsSync(path.join(instance, 'flows_cred.json')), false);
});

test('runner config disables keepalive/retries, requires explicit security, and bounds node-opcua transactions', () => {
  const { buildNodeOpcUaClientOptions, EXPECTED_NODE_OPCUA_VERSION, SECURITY_CONFIRMATION_PREFIX, resolveSecurityConfiguration } = require(path.join(instance, 'runtime', 'cpsLai3BrowseRunner.cjs'));
  const manager = { rootFolder: path.join(instance, 'pki') };
  const securityConfiguration = resolveSecurityConfiguration({ securityMode: 'None', securityPolicy: 'None', securityConfirmation: `${SECURITY_CONFIRMATION_PREFIX} None/None` });
  const options = buildNodeOpcUaClientOptions({ clientCertificateManager: manager, transactionTimeoutMs: 4321, securityConfiguration });
  assert.equal(options.clientCertificateManager, manager);
  assert.equal(options.securityMode, 'None');
  assert.equal(options.securityPolicy, 'None');
  assert.equal(options.keepSessionAlive, false);
  assert.equal(options.keepPendingSessionsOnDisconnect, false);
  assert.equal(options.connectionStrategy.maxRetry, 0);
  assert.equal(options.transportTimeout, 4321);
  assert.equal(options.defaultTransactionTimeout, 4321);
  assert.equal('userIdentity' in options, false);
  assert.throws(() => buildNodeOpcUaClientOptions({ clientCertificateManager: manager }), /confirmed OPC UA security configuration required/);
  assert.equal(resolveSecurityConfiguration({}).reason, 'SECURITY_POLICY_NOT_CONFIGURED');
  assert.equal(resolveSecurityConfiguration({ securityMode: 'Auto', securityPolicy: 'None', securityConfirmation: 'anything' }).reason, 'SECURITY_POLICY_INVALID');
  assert.equal(resolveSecurityConfiguration({ securityMode: 'None', securityPolicy: 'None', securityConfirmation: 'wrong' }).reason, 'SECURITY_POLICY_NOT_CONFIRMED');
  const installed = JSON.parse(fs.readFileSync(path.join(root, 'node-red', 'lai', 'node_modules', 'node-opcua', 'package.json'), 'utf8'));
  assert.equal(installed.version, EXPECTED_NODE_OPCUA_VERSION);
});
