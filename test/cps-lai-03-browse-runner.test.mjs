import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const { AUTHORIZATION_PHRASE, ENDPOINT, createBrowseRunner, SECURITY_CONFIRMATION_PREFIX, buildNodeOpcUaClientOptions } = require('../node-red/lai/cpslai3-browse-instance/runtime/cpsLai3BrowseRunner.cjs');
const LOCAL = { origin: 'http://localhost:1882', host: 'localhost:1882' };
const confirm = { ...LOCAL, confirmation: AUTHORIZATION_PHRASE };
const SECURITY = { securityMode: 'None', securityPolicy: 'None', securityConfirmation: `${SECURITY_CONFIRMATION_PREFIX} None/None` };
const statePaths = new Set();
function makeRunner(options = {}) {
  const stateFile = options.stateFile || path.join(os.tmpdir(), `cpslai3-browse-state-${randomUUID()}.json`);
  statePaths.add(stateFile);
  return createBrowseRunner({ stateFile, ...SECURITY, ...options });
}
test.after(async () => Promise.all([...statePaths].map(file => fs.rm(file, { force: true }))));

function makeHarness({ connect, createSession, browse, close, disconnect } = {}) {
  const calls = [];
  const session = {
    async browse(description) {
      calls.push({ method: 'browse', description });
      return browse ? browse(description) : { statusCode: 'Good', references: [], continuationPoint: null };
    },
    async browseNext(point, release) {
      calls.push({ method: 'browseNext', release });
      return { statusCode: 'Good', references: [], continuationPoint: null };
    },
    async read() { calls.push({ method: 'read' }); throw new Error('Read forbidden'); },
    async write() { calls.push({ method: 'write' }); throw new Error('Write forbidden'); },
    async call() { calls.push({ method: 'call' }); throw new Error('Call forbidden'); },
    async createSubscription() { calls.push({ method: 'subscribe' }); throw new Error('Subscribe forbidden'); },
    async close() { calls.push({ method: 'close' }); if (close) return close(); },
  };
  const client = {
    async connect(endpoint) { calls.push({ method: 'connect', endpoint }); if (connect) return connect(endpoint); },
    async createSession() { calls.push({ method: 'createSession' }); if (createSession) return createSession(); return session; },
    async disconnect() { calls.push({ method: 'disconnect' }); if (disconnect) return disconnect(); },
  };
  return { client, session, calls };
}

async function waitUntilIdle(runner, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (runner.getStatus().busy && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(runner.getStatus().busy, false, 'runner should finish within test timeout');
}

const limits = { maxDepth: 2, maxNodes: 20, maxBytes: 4096, maxDurationMs: 1000, maxReferencesPerNode: 10, maxBrowseRequests: 50, maxPathsPerNode: 5, requestTimeoutMs: 100, maxErrors: 20 };

test('runner starts disarmed and does not allocate a client without explicit arm and manual confirmation', () => {
  let clientCreations = 0;
  const runner = makeRunner({ createClient: () => { clientCreations += 1; }, writeResults: async () => { throw new Error('Must not write'); } });
  assert.equal(runner.getStatus().armed, false);
  assert.throws(() => runner.start(confirm), /disarmed/);
  assert.throws(() => makeRunner({ armValue: AUTHORIZATION_PHRASE }).start({ ...LOCAL, confirmation: 'wrong' }), /confirmation phrase/);
  assert.throws(() => makeRunner({ armValue: AUTHORIZATION_PHRASE }).start({ confirmation: AUTHORIZATION_PHRASE, origin: 'https://evil.example', host: 'localhost:1882' }), /same-origin/);
  assert.equal(clientCreations, 0);
});

test('OPC UA security policy must be explicit, allowlisted, and confirmed; options never rely on library defaults', () => {
  let clientCreations = 0;
  const missing = makeRunner({ armValue: AUTHORIZATION_PHRASE, securityMode: '', securityPolicy: '', securityConfirmation: '', createClient: () => { clientCreations += 1; } });
  assert.throws(() => missing.start(confirm), /SECURITY_POLICY_NOT_CONFIGURED/);
  const invalid = makeRunner({ armValue: AUTHORIZATION_PHRASE, securityMode: 'Auto', securityPolicy: 'Unknown', securityConfirmation: 'anything', createClient: () => { clientCreations += 1; } });
  assert.throws(() => invalid.start(confirm), /SECURITY_POLICY_INVALID/);
  const options = buildNodeOpcUaClientOptions({ securityConfiguration: { configured: true, confirmed: true, mode: 'None', policy: 'None' } });
  assert.equal(options.securityMode, 'None');
  assert.equal(options.securityPolicy, 'None');
  assert.equal(clientCreations, 0);
});

test('a correct explicit security confirmation is reported and passed to the injected client factory', async () => {
  const harness = makeHarness();
  let clientOptions;
  const runner = makeRunner({ armValue: AUTHORIZATION_PHRASE, createClient: options => { clientOptions = options; return harness.client; } });
  assert.deepEqual(runner.getStatus().securityConfiguration, { configured: true, confirmed: true, mode: 'None', policy: 'None', reason: null });
  runner.start(confirm);
  await waitUntilIdle(runner);
  assert.deepEqual(clientOptions, { securityMode: 'None', securityPolicy: 'None' });
});

test('successful authorized run uses only Browse, writes both exports, then closes session and client', async () => {
  const harness = makeHarness();
  const written = [];
  const runner = makeRunner({
    armValue: AUTHORIZATION_PHRASE,
    createClient: () => harness.client,
    limits,
    writeResults: async (_directory, runId, catalog) => {
      written.push({ runId, json: catalog.json, jsonl: catalog.jsonl });
      return { json: `${runId}.json`, jsonl: `${runId}.jsonl` };
    },
    readFile: async filePath => filePath.endsWith('.jsonl') ? written[0].jsonl : written[0].json,
  });
  const accepted = runner.start(confirm);
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.outcome, 'RUNNING');
  await waitUntilIdle(runner);
  const status = runner.getStatus();
  assert.equal(status.outcome, 'COMPLETE');
  assert.equal(status.armed, true);
  assert.equal(harness.calls[0].endpoint, ENDPOINT);
  assert.deepEqual(harness.calls.map(call => call.method), ['connect', 'createSession', 'browse', 'browse', 'browse', 'browse', 'browse', 'browse', 'close', 'disconnect']);
  assert.equal(written.length, 1);
  assert.ok(written[0].runId.startsWith('cpslai3-browse-'));
  assert.match(written[0].json, /OPC_UA_BROWSE_ONLY/);
  assert.match((await runner.getResult('json')).content, /OPC_UA_BROWSE_ONLY/);
  assert.match((await runner.getResult('jsonl')).content.split('\n')[0], /"recordType":"run"/);
  assert.equal(await runner.getResult('read'), null);
});

test('default persistence writes non-overwriting JSON and JSONL under the supplied isolated result directory', async t => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cpslai3-browse-offline-'));
  t.after(() => fs.rm(outputDir, { recursive: true, force: true }));
  const harness = makeHarness();
  const runner = makeRunner({
    armValue: AUTHORIZATION_PHRASE,
    outputDir,
    createClient: () => harness.client,
    limits,
  });
  runner.start(confirm);
  await waitUntilIdle(runner);
  const status = runner.getStatus();
  assert.ok(status.files.json.endsWith('.json'));
  assert.ok(status.files.jsonl.endsWith('.jsonl'));
  assert.notEqual(status.files.json, status.files.jsonl);
  assert.equal(JSON.parse(await fs.readFile(path.join(outputDir, status.files.json), 'utf8')).discoveryMode, 'OPC_UA_BROWSE_ONLY');
  assert.match(await fs.readFile(path.join(outputDir, status.files.jsonl), 'utf8'), /"recordType":"run"/);
});

test('serializes concurrent runs and supports manual cancellation with cleanup after the request settles', async () => {
  let began;
  const requestStarted = new Promise(resolve => { began = resolve; });
  const harness = makeHarness({
    browse: () => {
      began();
      return new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('mock transaction timeout'), { code: 'MOCK_TIMEOUT' })), 25));
    },
  });
  const runner = makeRunner({
    armValue: AUTHORIZATION_PHRASE,
    createClient: () => harness.client,
    limits: { ...limits, requestTimeoutMs: 100 },
    settleTimeoutMs: 100,
    writeResults: async (_directory, runId) => ({ json: `${runId}.json`, jsonl: `${runId}.jsonl` }),
  });
  runner.start(confirm);
  await requestStarted;
  assert.throws(() => runner.start(confirm), /already active/);
  assert.equal(runner.cancel(LOCAL).accepted, true);
  await waitUntilIdle(runner);
  assert.ok(harness.calls.findIndex(call => call.method === 'close') > harness.calls.findIndex(call => call.method === 'browse'));
  assert.ok(harness.calls.findIndex(call => call.method === 'disconnect') > harness.calls.findIndex(call => call.method === 'close'));
  assert.equal(harness.calls.some(call => ['read', 'write', 'call', 'subscribe'].includes(call.method)), false);
});

test('connect/session failures still disconnect and close only resources that were created', async t => {
  await t.test('connect failure', async () => {
    const harness = makeHarness({ connect: async () => { throw Object.assign(new Error('connect timeout'), { code: 'ETIMEDOUT' }); } });
    const runner = makeRunner({ armValue: AUTHORIZATION_PHRASE, createClient: () => harness.client, limits });
    runner.start(confirm);
    await waitUntilIdle(runner);
    assert.deepEqual(harness.calls.map(call => call.method), ['connect', 'disconnect']);
    assert.equal(runner.getStatus().outcome, 'FAILED');
  });
  await t.test('createSession failure', async () => {
    const harness = makeHarness({ createSession: async () => { throw new Error('session failed'); } });
    const runner = makeRunner({ armValue: AUTHORIZATION_PHRASE, createClient: () => harness.client, limits });
    runner.start(confirm);
    await waitUntilIdle(runner);
    assert.deepEqual(harness.calls.map(call => call.method), ['connect', 'createSession', 'disconnect']);
    assert.equal(runner.getStatus().blocked, true);
    assert.throws(() => runner.start(confirm), /BLOCKED/);
  });
});

test('session close failure does not prevent client disconnect and is reported', async () => {
  const harness = makeHarness({ close: async () => { throw new Error('close failed'); } });
  const stateFile = path.join(os.tmpdir(), `cpslai3-close-failure-${randomUUID()}.json`);
  statePaths.add(stateFile);
  const runner = makeRunner({ stateFile, armValue: AUTHORIZATION_PHRASE, createClient: () => harness.client, limits });
  runner.start(confirm);
  await waitUntilIdle(runner);
  assert.ok(harness.calls.some(call => call.method === 'disconnect'));
  assert.equal(runner.getStatus().outcome, 'FAILED');
  assert.ok(runner.getStatus().cleanupWarning);
  assert.equal(runner.getStatus().blocked, true);
  const restarted = makeRunner({ stateFile, armValue: AUTHORIZATION_PHRASE, createClient: () => { throw new Error('blocked runner must not allocate'); } });
  assert.equal(restarted.getStatus().blocked, true);
  assert.equal(restarted.cancel(LOCAL).accepted, false);
  assert.equal(restarted.getStatus().blocked, true);
  assert.throws(() => restarted.start(confirm), /BLOCKED/);
});

test('timeout of a Browse call waits for the simulated node-opcua transaction to settle before CloseSession', async () => {
  const harness = makeHarness({
    browse: () => new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('mock UA transaction timeout'), { code: 'MOCK_TIMEOUT' })), 35)),
  });
  const runner = makeRunner({
    armValue: AUTHORIZATION_PHRASE,
    createClient: () => harness.client,
    limits: { ...limits, requestTimeoutMs: 10 },
    settleTimeoutMs: 100,
    writeResults: async (_directory, runId) => ({ json: `${runId}.json`, jsonl: `${runId}.jsonl` }),
  });
  runner.start(confirm);
  await waitUntilIdle(runner);
  const browseIndex = harness.calls.findIndex(call => call.method === 'browse');
  const closeIndex = harness.calls.findIndex(call => call.method === 'close');
  assert.ok(closeIndex > browseIndex);
  assert.equal(harness.calls.at(-1).method, 'disconnect');
  assert.equal(runner.getStatus().outcome, 'PARTIAL');
});

test('unsettled Browse skips CloseSession, persists BLOCKED, and requires separately documented external evidence to release', async () => {
  const stateFile = path.join(os.tmpdir(), `cpslai3-pending-${randomUUID()}.json`);
  statePaths.add(stateFile);
  const harness = makeHarness();
  const runner = makeRunner({
    stateFile,
    armValue: AUTHORIZATION_PHRASE,
    createClient: () => harness.client,
    settleTimeoutMs: 5,
    closeTimeoutMs: 10,
    loadExplorer: async () => ({
      createBrowseOnlyFacade: session => session,
      discoverCpsLai3BrowseCatalog: async () => ({
        document: { statistics: { sessionCloseRequired: true, truncated: true } },
        json: '{}', jsonl: '{}\n',
        settlePending: () => new Promise(() => {}),
      }),
    }),
    writeResults: async () => ({ json: 'mock.json', jsonl: 'mock.jsonl' }),
  });
  runner.start(confirm);
  await waitUntilIdle(runner);
  assert.equal(runner.getStatus().blocked, true);
  assert.equal(harness.calls.some(call => call.method === 'close'), false);
  assert.equal(harness.calls.some(call => call.method === 'disconnect'), true);
  const restarted = makeRunner({ stateFile, armValue: AUTHORIZATION_PHRASE, createClient: () => { throw new Error('blocked runner must not allocate'); } });
  assert.throws(() => restarted.start(confirm), /BLOCKED/);
  assert.throws(() => restarted.releaseBlock({ ...LOCAL, operator: 'LAI operator', justification: 'Verified session closed', externalEvidence: 'log' }), /evidence/);
  const release = restarted.releaseBlock({ ...LOCAL, operator: 'LAI operator', justification: 'Verified session closed independently', externalEvidence: 'Server diagnostic log #SESSION-123 confirms closed' });
  assert.equal(release.released, true);
  assert.equal(restarted.getStatus().blocked, false);
  const saved = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  assert.equal(saved.releaseHistory.at(-1).operator, 'LAI operator');
  assert.equal(saved.releaseHistory.at(-1).externalEvidence, 'Server diagnostic log #SESSION-123 confirms closed');
});

test('restart with an active-run marker or corrupt persistent state fails closed', async t => {
  await t.test('active marker is converted into persistent BLOCKED', async () => {
    const stateFile = path.join(os.tmpdir(), `cpslai3-active-${randomUUID()}.json`);
    statePaths.add(stateFile);
    await fs.writeFile(stateFile, JSON.stringify({ schemaVersion: 1, blocked: false, block: null, activeRun: { runId: 'crashed-run', stage: 'SESSION_CREATED' }, lastRun: null, releaseHistory: [] }));
    const runner = makeRunner({ stateFile, armValue: AUTHORIZATION_PHRASE });
    assert.equal(runner.getStatus().blocked, true);
    assert.equal(runner.getStatus().block.reason, 'PROCESS_EXIT_DURING_ACTIVE_RUN');
    assert.throws(() => runner.start(confirm), /BLOCKED/);
    assert.equal(JSON.parse(await fs.readFile(stateFile, 'utf8')).blocked, true);
  });
  await t.test('corrupt state blocks start until explicit supervised repair', async () => {
    const stateFile = path.join(os.tmpdir(), `cpslai3-corrupt-${randomUUID()}.json`);
    statePaths.add(stateFile);
    await fs.writeFile(stateFile, '{ definitely not JSON');
    const runner = makeRunner({ stateFile, armValue: AUTHORIZATION_PHRASE });
    assert.equal(runner.getStatus().stateUnreadable, true);
    assert.throws(() => runner.start(confirm), /BLOCKED/);
    const release = runner.releaseBlock({ ...LOCAL, operator: 'operator', justification: 'Checked external server diagnostics', externalEvidence: 'External record SESSION-CLOSED-77 confirmed by operator' });
    assert.equal(release.released, true);
    assert.ok(release.preservedStateFile);
    const preservedPath = path.join(path.dirname(stateFile), release.preservedStateFile);
    statePaths.add(preservedPath);
    assert.equal(await fs.readFile(preservedPath, 'utf8'), '{ definitely not JSON');
    assert.equal(runner.getStatus().blocked, false);
  });
});

test('failure to persist the active marker prevents client construction and leaves runner blocked', () => {
  const brokenIO = {
    readFileSync() { const error = new Error('not found'); error.code = 'ENOENT'; throw error; },
    mkdirSync() { throw new Error('storage unavailable'); },
  };
  let clientCreations = 0;
  const runner = makeRunner({ stateIO: brokenIO, armValue: AUTHORIZATION_PHRASE, createClient: () => { clientCreations += 1; } });
  assert.throws(() => runner.start(confirm), /Cannot persist active-run marker/);
  assert.equal(clientCreations, 0);
  assert.equal(runner.getStatus().blocked, true);
});
