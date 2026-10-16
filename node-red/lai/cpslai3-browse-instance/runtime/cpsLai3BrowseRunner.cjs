'use strict';

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');

const AUTHORIZATION_PHRASE = 'AUTHORIZE CPS-LAI-03 BROWSE';
const ENDPOINT = 'opc.tcp://192.168.1.30:4840';
const EXPECTED_NODE_OPCUA_VERSION = '2.160.0';
const TRANSACTION_TIMEOUT_MS = 5000;
const STATE_SCHEMA_VERSION = 1;
const SECURITY_CONFIRMATION_PREFIX = 'CONFIRM CPS-LAI-03 OPC UA SECURITY';
const ALLOWED_SECURITY_MODES = new Set(['None', 'Sign', 'SignAndEncrypt']);
const ALLOWED_SECURITY_POLICIES = new Set([
  'None', 'Basic128Rsa15', 'Basic256', 'Basic256Sha256',
  'Aes128_Sha256_RsaOaep', 'Aes256_Sha256_RsaPss',
]);
const EXPLORER_LIMITS = Object.freeze({
  maxDepth: 6,
  maxNodes: 5000,
  maxBytes: 10 * 1024 * 1024,
  maxDurationMs: 2 * 60 * 1000,
  maxReferencesPerNode: 100,
  maxBrowseRequests: 10000,
  maxPathsPerNode: 64,
  requestTimeoutMs: 6500,
  maxErrors: 500,
});

function publicError(error) {
  const message = String(error?.message || error)
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, '$1[redacted]@')
    .replace(/((?:password|token|secret|authorization|apikey)=)[^&\s]+/gi, '$1[redacted]');
  return { code: error?.code || 'BROWSE_RUN_FAILED', message: message.slice(0, 500) };
}

function resolveSecurityConfiguration({ securityMode, securityPolicy, securityConfirmation } = {}) {
  const mode = String(securityMode || '').trim();
  const policy = String(securityPolicy || '').trim();
  if (!mode || !policy) return { configured: false, confirmed: false, reason: 'SECURITY_POLICY_NOT_CONFIGURED' };
  if (!ALLOWED_SECURITY_MODES.has(mode) || !ALLOWED_SECURITY_POLICIES.has(policy)) {
    return { configured: false, confirmed: false, reason: 'SECURITY_POLICY_INVALID' };
  }
  const expectedConfirmation = `${SECURITY_CONFIRMATION_PREFIX} ${mode}/${policy}`;
  if (securityConfirmation !== expectedConfirmation) {
    return { configured: true, confirmed: false, mode, policy, reason: 'SECURITY_POLICY_NOT_CONFIRMED' };
  }
  return { configured: true, confirmed: true, mode, policy, reason: null };
}

function buildNodeOpcUaClientOptions({ clientCertificateManager, transactionTimeoutMs = TRANSACTION_TIMEOUT_MS, securityConfiguration } = {}) {
  if (!securityConfiguration?.configured || !securityConfiguration?.confirmed) {
    throw Object.assign(new Error(securityConfiguration?.reason || 'Explicitly confirmed OPC UA security configuration required'), { code: 'SECURITY_CONFIGURATION_REQUIRED' });
  }
  return {
    clientName: 'CPS-LAI-03-Browse-Only-Experimental',
    clientCertificateManager,
    securityMode: securityConfiguration.mode,
    securityPolicy: securityConfiguration.policy,
    connectionStrategy: { maxRetry: 0, initialDelay: 100, maxDelay: 100 },
    transportTimeout: transactionTimeoutMs,
    defaultTransactionTimeout: transactionTimeoutMs,
    keepSessionAlive: false,
    keepPendingSessionsOnDisconnect: false,
  };
}

function localRequest(origin, host) {
  const allowedOrigins = new Set(['http://localhost:1882', 'http://127.0.0.1:1882']);
  const allowedHosts = new Set(['localhost:1882', '127.0.0.1:1882']);
  return allowedOrigins.has(String(origin || '')) && allowedHosts.has(String(host || '').toLowerCase());
}

function createNodeOpcUaClient({ userDir, createClient, transactionTimeoutMs, securityConfiguration }) {
  if (createClient) return createClient({ securityMode: securityConfiguration.mode, securityPolicy: securityConfiguration.policy });
  const searchRoot = path.resolve(__dirname, '../..');
  const nodeOpcuaPackagePath = require.resolve('node-opcua/package.json', { paths: [searchRoot] });
  const nodeOpcuaPackage = require(nodeOpcuaPackagePath);
  if (nodeOpcuaPackage.version !== EXPECTED_NODE_OPCUA_VERSION) {
    throw new Error(`Expected node-opcua ${EXPECTED_NODE_OPCUA_VERSION}; found ${nodeOpcuaPackage.version || 'unknown'}`);
  }
  const { OPCUAClient } = require(require.resolve('node-opcua', { paths: [searchRoot] }));
  const { OPCUACertificateManager } = require(require.resolve('node-opcua-certificate-manager', { paths: [searchRoot] }));
  const clientCertificateManager = new OPCUACertificateManager({
    rootFolder: path.join(userDir, 'pki'),
    automaticallyAcceptUnknownCertificate: false,
  });
  return OPCUAClient.create({
    ...buildNodeOpcUaClientOptions({ clientCertificateManager, transactionTimeoutMs, securityConfiguration }),
    // No username/password or certificate is copied from the operational instance.
  });
}

function emptyPersistentState() {
  return { schemaVersion: STATE_SCHEMA_VERSION, blocked: false, block: null, activeRun: null, lastRun: null, releaseHistory: [], updatedAt: new Date().toISOString() };
}

function readPersistentState(stateFile, io = fsSync) {
  try {
    const raw = io.readFileSync(stateFile, 'utf8');
    const value = JSON.parse(raw);
    if (!value || value.schemaVersion !== STATE_SCHEMA_VERSION || typeof value.blocked !== 'boolean' || !Array.isArray(value.releaseHistory)) throw new Error('State schema invalid');
    return value;
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyPersistentState();
    return { ...emptyPersistentState(), blocked: true, block: { reason: 'STATE_UNREADABLE', detectedAt: new Date().toISOString(), detail: String(error?.message || error).slice(0, 300) }, stateUnreadable: true };
  }
}

function writePersistentState(stateFile, state, io = fsSync) {
  io.mkdirSync(path.dirname(stateFile), { recursive: true });
  const tempFile = `${stateFile}.${process.pid}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = io.openSync(tempFile, 'wx', 0o600);
    io.writeFileSync(fd, `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
    io.fsyncSync(fd);
    io.closeSync(fd);
    fd = null;
    io.renameSync(tempFile, stateFile);
  } catch (error) {
    if (fd !== undefined && fd !== null) { try { io.closeSync(fd); } catch {} }
    try { io.rmSync(tempFile, { force: true }); } catch {}
    throw error;
  }
}

function createBrowseRunner({
  userDir = path.resolve(__dirname, '..'),
  outputDir = path.join(userDir, 'results'),
  endpoint = ENDPOINT,
  armValue = '',
  securityMode = '',
  securityPolicy = '',
  securityConfirmation = '',
  stateFile = path.join(userDir, 'runner-state.json'),
  stateIO = fsSync,
  createClient,
  loadExplorer = () => import(pathToFileURL(path.resolve(__dirname, '../../../../lib/opcua/cpsLai3BrowseCatalog.mjs')).href),
  writeResults = async (directory, runId, catalog) => {
    await fs.mkdir(directory, { recursive: true });
    const jsonName = `${runId}.json`;
    const jsonlName = `${runId}.jsonl`;
    await fs.writeFile(path.join(directory, jsonName), catalog.json, { encoding: 'utf8', flag: 'wx' });
    try {
      await fs.writeFile(path.join(directory, jsonlName), catalog.jsonl, { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      await fs.rm(path.join(directory, jsonName), { force: true }).catch(() => {});
      throw error;
    }
    return { json: jsonName, jsonl: jsonlName };
  },
  readFile = filePath => fs.readFile(filePath, 'utf8'),
  settleTimeoutMs = TRANSACTION_TIMEOUT_MS + 1500,
  closeTimeoutMs = TRANSACTION_TIMEOUT_MS + 1500,
  transactionTimeoutMs = TRANSACTION_TIMEOUT_MS,
  limits = EXPLORER_LIMITS,
  clock = Date.now,
} = {}) {
  const securityConfiguration = resolveSecurityConfiguration({ securityMode, securityPolicy, securityConfirmation });
  let persistentState = readPersistentState(stateFile, stateIO);
  let persistenceFailure = null;
  if (persistentState.activeRun && !persistentState.blocked) {
    persistentState = { ...persistentState, blocked: true, block: { reason: 'PROCESS_EXIT_DURING_ACTIVE_RUN', detectedAt: new Date().toISOString(), activeRun: persistentState.activeRun } };
    try { writePersistentState(stateFile, persistentState, stateIO); }
    catch (error) { persistenceFailure = publicError(error); }
  }
  const diskWasUnreadable = persistentState.stateUnreadable === true;
  const state = {
    armed: armValue === AUTHORIZATION_PHRASE,
    busy: false,
    runId: null,
    startedAt: null,
    finishedAt: null,
    outcome: 'IDLE',
    summary: null,
    files: null,
    error: null,
    cleanupWarning: null,
    blocked: persistentState.blocked,
    block: persistentState.block || null,
    stateUnreadable: diskWasUnreadable,
    persistenceFailure,
    securityConfiguration: {
      configured: securityConfiguration.configured,
      confirmed: securityConfiguration.confirmed,
      mode: securityConfiguration.mode || null,
      policy: securityConfiguration.policy || null,
      reason: securityConfiguration.reason,
    },
  };
  let activeController = null;
  let activeRunPromise = null;

  const boundedCleanup = async (promise, timeoutMs, label) => {
    let timer;
    try {
      return await Promise.race([
        Promise.resolve(promise),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error(`${label} exceeded ${timeoutMs} ms`), { code: 'CLEANUP_TIMEOUT' })), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  const execute = async ({ runId, signal }) => {
    let client = null;
    let session = null;
    let catalog = null;
    let explorer;
    let primaryError = null;
    let pendingBrowseSettled = true;
    let sessionClosed = false;
    let clientDisconnected = false;
    let sessionCreationAttempted = false;
    let stage = 'AUTHORIZED';
    try {
      if (signal.aborted) throw Object.assign(new Error('Execution cancelled before client creation'), { code: 'BROWSE_CANCELLED' });
      // Importing the traversal module is offline; client creation is the first
      // step that can allocate OPC UA resources and occurs only after both gates.
      explorer = await loadExplorer();
      if (signal.aborted) throw Object.assign(new Error('Execution cancelled before client creation'), { code: 'BROWSE_CANCELLED' });
      client = await createNodeOpcUaClient({ userDir, createClient, transactionTimeoutMs, securityConfiguration });
      stage = 'CLIENT_CREATED';
      persistActiveStage(runId, stage);
      stage = 'CONNECTING';
      persistActiveStage(runId, stage);
      await client.connect(endpoint);
      if (signal.aborted) throw Object.assign(new Error('Execution cancelled after connect'), { code: 'BROWSE_CANCELLED' });
      sessionCreationAttempted = true;
      stage = 'CREATING_SESSION';
      persistActiveStage(runId, stage);
      session = await client.createSession();
      stage = 'SESSION_CREATED';
      persistActiveStage(runId, stage);
      if (signal.aborted) throw Object.assign(new Error('Execution cancelled after session creation'), { code: 'BROWSE_CANCELLED' });

      const facade = explorer.createBrowseOnlyFacade(session);
      catalog = await explorer.discoverCpsLai3BrowseCatalog({
        session: facade,
        limits,
        signal,
      });
      if (catalog.document.statistics.sessionCloseRequired && typeof catalog.settlePending === 'function') {
        try {
          await boundedCleanup(catalog.settlePending(), settleTimeoutMs, 'OPC UA Browse settlement');
          pendingBrowseSettled = true;
        } catch (error) {
          pendingBrowseSettled = false;
          state.cleanupWarning = publicError(error);
        }
      }
      state.files = await writeResults(outputDir, runId, catalog);
      state.summary = catalog.document.statistics;
      if (signal.aborted) state.outcome = 'CANCELLED';
      else if (catalog.document.statistics.truncated) state.outcome = 'PARTIAL';
      else state.outcome = 'COMPLETE';
      return { runId, summary: state.summary, files: state.files, outcome: state.outcome };
    } catch (error) {
      primaryError = error;
      state.error = publicError(error);
      state.outcome = error?.code === 'BROWSE_CANCELLED' ? 'CANCELLED' : 'FAILED';
      throw error;
    } finally {
      const cleanupErrors = [];
      let cleanupFailure = null;
      if (session && pendingBrowseSettled) {
        try {
          await boundedCleanup(session.close(), closeTimeoutMs, 'OPC UA CloseSession');
          sessionClosed = true;
        } catch (error) {
          cleanupErrors.push(publicError(error));
        }
      } else if (session) {
        cleanupErrors.push({ code: 'SESSION_CLOSE_SKIPPED', message: 'Browse request did not settle; closing transport to avoid overlapping OPC UA services.' });
      }
      if (client) {
        try {
          await boundedCleanup(client.disconnect(), closeTimeoutMs, 'OPC UA disconnect');
          clientDisconnected = true;
        } catch (error) {
          cleanupErrors.push(publicError(error));
        }
      }
      if (cleanupErrors.length) {
        state.cleanupWarning = { errors: cleanupErrors, sessionClosed, clientDisconnected };
        if (!primaryError) {
          cleanupFailure = new Error('OPC UA lifecycle cleanup was incomplete');
          cleanupFailure.code = 'BROWSE_CLEANUP_INCOMPLETE';
        }
      }
      const safelyReleased = (session ? sessionClosed : !sessionCreationAttempted) && (!client || clientDisconnected);
      if (safelyReleased && cleanupErrors.length === 0) {
        try {
          persistentState = { ...persistentState, activeRun: null, lastRun: { runId, finishedAt: new Date(clock()).toISOString(), outcome: state.outcome, security: { mode: securityConfiguration.mode, policy: securityConfiguration.policy }, sessionClosed, clientDisconnected } };
          persistState();
        } catch (error) {
          blockRun(runId, 'STATE_PERSISTENCE_FAILED', [publicError(error)], { stage, sessionClosed, clientDisconnected });
        }
      } else {
        blockRun(runId, !pendingBrowseSettled ? 'PENDING_BROWSE_NOT_SETTLED' : (!sessionClosed && session ? 'CLOSE_SESSION_UNCONFIRMED' : 'SESSION_RELEASE_UNCONFIRMED'), cleanupErrors, { stage, sessionClosed, clientDisconnected });
      }
      if (cleanupFailure) throw cleanupFailure;
    }
  };

  function persistState() {
    if (persistentState.stateUnreadable) throw new Error('Persistent runner state is unreadable; supervised recovery is required');
    writePersistentState(stateFile, persistentState, stateIO);
    state.blocked = persistentState.blocked;
    state.block = persistentState.block;
    state.persistenceFailure = null;
  }

  function persistActiveStage(runId, stage) {
    persistentState = { ...persistentState, activeRun: { ...(persistentState.activeRun || {}), runId, stage, updatedAt: new Date(clock()).toISOString(), security: { mode: securityConfiguration.mode, policy: securityConfiguration.policy } } };
    persistState();
  }

  function blockRun(runId, reason, errors, details = {}) {
    const block = { reason, detectedAt: new Date(clock()).toISOString(), runId, errors, details, security: { mode: securityConfiguration.mode || null, policy: securityConfiguration.policy || null } };
    persistentState = { ...persistentState, blocked: true, block, activeRun: persistentState.activeRun || { runId, stage: details.stage || 'UNKNOWN' } };
    state.blocked = true;
    state.block = block;
    try { persistState(); }
    catch (error) {
      state.blocked = true;
      state.block = { ...block, persistenceFailed: true };
      state.persistenceFailure = publicError(error);
    }
  }

  const start = ({ confirmation, origin, host } = {}) => {
    if (!localRequest(origin, host)) throw Object.assign(new Error('Local same-origin request required'), { statusCode: 403 });
    if (!state.armed) throw Object.assign(new Error('Runner is disarmed; explicit runtime authorization is required'), { statusCode: 403 });
    if (confirmation !== AUTHORIZATION_PHRASE) throw Object.assign(new Error('Manual confirmation phrase did not match'), { statusCode: 403 });
    if (state.busy) throw Object.assign(new Error('A discovery run is already active'), { statusCode: 409 });
    if (!securityConfiguration.configured || !securityConfiguration.confirmed) throw Object.assign(new Error(`OPC UA security configuration is not explicitly confirmed: ${securityConfiguration.reason}`), { statusCode: 403, code: securityConfiguration.reason });
    if (state.blocked || persistentState.blocked || state.stateUnreadable) throw Object.assign(new Error('Runner is persistently BLOCKED; supervised release with external session-closure evidence is required'), { statusCode: 423, code: 'RUNNER_BLOCKED' });

    const runId = `cpslai3-browse-${new Date(clock()).toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
    const controller = new AbortController();
    activeController = controller;
    state.busy = true;
    state.runId = runId;
    state.startedAt = new Date(clock()).toISOString();
    state.finishedAt = null;
    state.outcome = 'RUNNING';
    state.summary = null;
    state.files = null;
    state.error = null;
    state.cleanupWarning = null;
    try {
      persistentState = { ...persistentState, activeRun: { runId, stage: 'AUTHORIZED_START', startedAt: state.startedAt, security: { mode: securityConfiguration.mode, policy: securityConfiguration.policy } } };
      persistState();
    } catch (error) {
      state.busy = false;
      activeController = null;
      activeRunPromise = null;
      state.outcome = 'BLOCKED';
      blockRun(runId, 'STATE_PERSISTENCE_FAILED', [publicError(error)], { stage: 'AUTHORIZED_START' });
      throw Object.assign(new Error('Cannot persist active-run marker; discovery was not started'), { statusCode: 503, code: 'STATE_PERSISTENCE_FAILED' });
    }

    activeRunPromise = execute({ runId, signal: controller.signal })
      .catch(error => {
        state.error ||= publicError(error);
        state.outcome = error?.code === 'BROWSE_CANCELLED' ? 'CANCELLED' : 'FAILED';
        return null;
      })
      .finally(() => {
        state.busy = false;
        state.finishedAt = new Date(clock()).toISOString();
        activeController = null;
        activeRunPromise = null;
      });
    return { accepted: true, runId, outcome: 'RUNNING' };
  };

  const cancel = ({ origin, host } = {}) => {
    if (!localRequest(origin, host)) throw Object.assign(new Error('Local same-origin request required'), { statusCode: 403 });
    if (!state.busy || !activeController) return { accepted: false, outcome: state.outcome };
    activeController.abort();
    return { accepted: true, runId: state.runId, outcome: 'CANCELLING' };
  };

  const getStatus = () => ({ ...state });

  const releaseBlock = ({ operator, justification, externalEvidence, origin, host } = {}) => {
    if (!localRequest(origin, host)) throw Object.assign(new Error('Local same-origin request required'), { statusCode: 403 });
    if (state.busy) throw Object.assign(new Error('Cannot release block while a run is active'), { statusCode: 409 });
    if (!state.blocked && !state.stateUnreadable) throw Object.assign(new Error('Runner is not BLOCKED; supervised release is not applicable'), { statusCode: 409 });
    const clean = value => typeof value === 'string' ? value.trim() : '';
    const release = { operator: clean(operator), justification: clean(justification), externalEvidence: clean(externalEvidence), releasedAt: new Date(clock()).toISOString() };
    if (release.operator.length < 2 || release.justification.length < 12 || release.externalEvidence.length < 12) {
      throw Object.assign(new Error('Operator, justification, and documented external session-closure evidence are required'), { statusCode: 400 });
    }
    const releaseState = {
      schemaVersion: STATE_SCHEMA_VERSION,
      blocked: false,
      block: null,
      activeRun: null,
      lastRun: persistentState.lastRun,
      releaseHistory: [...(Array.isArray(persistentState.releaseHistory) ? persistentState.releaseHistory : []), { ...release, clearedReason: persistentState.block?.reason || 'EXPLICIT_SUPERVISED_RELEASE' }].slice(-100),
      updatedAt: release.releasedAt,
    };
    let preservedStateFile = null;
    try {
      if (state.stateUnreadable) {
        preservedStateFile = `${stateFile}.corrupt-${new Date(clock()).toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
        stateIO.copyFileSync(stateFile, preservedStateFile, fsSync.constants.COPYFILE_EXCL);
        releaseState.releaseHistory[releaseState.releaseHistory.length - 1].preservedUnreadableState = path.basename(preservedStateFile);
      }
      writePersistentState(stateFile, releaseState, stateIO);
    } catch (error) {
      state.blocked = true;
      state.persistenceFailure = publicError(error);
      throw Object.assign(new Error('Could not persist supervised release; runner remains BLOCKED'), { statusCode: 503, code: 'STATE_PERSISTENCE_FAILED' });
    }
    persistentState = releaseState;
    state.blocked = false;
    state.block = null;
    state.stateUnreadable = false;
    state.persistenceFailure = null;
    return { released: true, releasedAt: release.releasedAt, preservedStateFile: preservedStateFile ? path.basename(preservedStateFile) : null };
  };

  const getResult = async format => {
    if (!state.files || !['json', 'jsonl'].includes(format)) return null;
    const filename = state.files[format];
    return {
      filename,
      contentType: format === 'json' ? 'application/json; charset=utf-8' : 'application/x-ndjson; charset=utf-8',
      content: await readFile(path.join(outputDir, filename)),
    };
  };

  return Object.freeze({ start, cancel, getStatus, getResult, releaseBlock });
}

module.exports = { AUTHORIZATION_PHRASE, ENDPOINT, EXPLORER_LIMITS, EXPECTED_NODE_OPCUA_VERSION, SECURITY_CONFIRMATION_PREFIX, buildNodeOpcUaClientOptions, createBrowseRunner, resolveSecurityConfiguration };
