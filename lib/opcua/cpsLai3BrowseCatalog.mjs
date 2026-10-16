/**
 * Bounded, sequential, Browse-only address-space cataloguer for CPS-LAI-03.
 * This module deliberately does not create a client/session and never calls
 * Read, Write, Call, Subscribe, or crawler APIs. The host owns connection and
 * session lifecycle; pass only a session object with browse/browseNext methods.
 */

export const CPS_LAI_03_BROWSE_ROOTS = Object.freeze([
  { nodeId: 'ns=3;s=Inputs', name: 'Inputs' },
  { nodeId: 'ns=3;s=Outputs', name: 'Outputs' },
  { nodeId: 'ns=3;s=Memory', name: 'Memory' },
  { nodeId: 'ns=3;s=PLC', name: 'PLC' },
  { nodeId: 'ns=3;s=DataBlocksGlobal', name: 'DataBlocksGlobal' },
  { nodeId: 'ns=3;s=DataBlocksInstance', name: 'DataBlocksInstance' },
]);

export const DEFAULT_BROWSE_LIMITS = Object.freeze({
  maxDepth: 6,
  maxNodes: 5000,
  maxBytes: 10 * 1024 * 1024,
  maxDurationMs: 2 * 60 * 1000,
  maxReferencesPerNode: 100,
  maxBrowseRequests: 10000,
  maxPathsPerNode: 64,
  requestTimeoutMs: 5000,
  maxErrors: 500,
});

const HIERARCHICAL_REFERENCES = 'i=33';
const BROWSE_RESULT_MASK = 0x3f;
const LIMIT_KEYS = Object.keys(DEFAULT_BROWSE_LIMITS);

function boundedInteger(value, fallback, key) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new TypeError(`Invalid limit: ${key}`);
  return parsed;
}

function normalizeLimits(overrides = {}) {
  const limits = {};
  for (const key of LIMIT_KEYS) limits[key] = boundedInteger(overrides[key], DEFAULT_BROWSE_LIMITS[key], key);
  if (limits.maxBytes < 4096) throw new TypeError('maxBytes must be at least 4096 to fit required catalogue metadata');
  return limits;
}

function nodeIdText(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  if (typeof value.toString === 'function') return value.toString();
  return String(value);
}

function localizedText(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  return value.text == null ? String(value) : String(value.text);
}

const NODE_CLASSES = ['Unspecified', 'Object', 'Variable', 'Method', 'ObjectType', 'VariableType', 'ReferenceType', 'DataType', 'View'];
function nodeClassText(value) {
  if (typeof value === 'string') return value;
  return NODE_CLASSES[Number(value)] || (value == null ? null : String(value));
}

function statusText(statusCode) {
  if (statusCode == null) return null;
  if (typeof statusCode === 'string') return statusCode;
  if (typeof statusCode.toString === 'function') return statusCode.toString();
  return String(statusCode.name ?? statusCode.value ?? statusCode);
}

function continuationPoint(result) {
  const value = result?.continuationPoint;
  return value && (Buffer.isBuffer(value) ? value.length > 0 : String(value).length > 0) ? value : null;
}

function safeError(error) {
  // Keep diagnostic text useful without accidentally serializing connection options.
  const message = String(error?.message || error)
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, '$1[redacted]@')
    .replace(/((?:password|token|secret|authorization|apikey)=)[^&\s]+/gi, '$1[redacted]');
  return { name: String(error?.name || 'Error'), message: message.slice(0, 500) };
}

function makeTimeout(ms, signal, label, ignoreAbort = false) {
  let timer;
  let abortHandler;
  const promise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(Object.assign(new Error(`${label} timed out after ${ms} ms`), { code: 'BROWSE_TIMEOUT' }));
    }, ms);
    if (!ignoreAbort && signal) {
      abortHandler = () => {
        reject(Object.assign(new Error('Browse cancelled'), { code: 'BROWSE_CANCELLED' }));
      };
      signal.addEventListener('abort', abortHandler, { once: true });
    }
  });
  return {
    promise,
    cancel() {
      clearTimeout(timer);
      if (abortHandler) signal?.removeEventListener('abort', abortHandler);
    },
  };
}

function nowIso(clock) {
  return new Date(clock()).toISOString();
}

function referenceRecord(reference, parentNodeId, parentPath, depth) {
  const id = nodeIdText(reference?.nodeId);
  if (!id) return null;
  const browseName = reference?.browseName;
  const segment = browseName?.name == null ? localizedText(browseName) : String(browseName.name);
  const path = [...parentPath, segment || id];
  return {
    nodeId: id,
    browseName: segment || null,
    browseNameNamespaceIndex: browseName?.namespaceIndex ?? null,
    displayName: localizedText(reference?.displayName),
    nodeClass: nodeClassText(reference?.nodeClass),
    parentNodeId,
    hierarchicalPath: path,
    referenceTypeId: nodeIdText(reference?.referenceTypeId),
    isForward: reference?.isForward ?? null,
    typeDefinition: nodeIdText(reference?.typeDefinition?.nodeId ?? reference?.typeDefinition),
    depth,
  };
}

function serializeJsonl(document) {
  const records = [{
    recordType: 'run',
    schemaVersion: document.schemaVersion,
    cpsId: document.cpsId,
    formalCpsId: document.formalCpsId,
    station: document.station,
    discoveryMode: document.discoveryMode,
    startedAt: document.startedAt,
    finishedAt: document.finishedAt,
    durationMs: document.durationMs,
    roots: document.roots,
    limits: document.limits,
    statistics: document.statistics,
  }];
  for (const error of document.errors) records.push({ recordType: 'error', ...error });
  for (const node of document.nodes) records.push({ recordType: 'node', ...node });
  return records.map(record => JSON.stringify(record)).join('\n') + '\n';
}

/**
 * Traverse only using session.browse() and session.browseNext().
 * The returned catalogue is deterministic for a given server response order.
 */
export async function discoverCpsLai3BrowseCatalog({
  session,
  roots = CPS_LAI_03_BROWSE_ROOTS,
  limits: limitOverrides,
  signal,
  clock = Date.now,
} = {}) {
  if (!session || typeof session.browse !== 'function' || typeof session.browseNext !== 'function') {
    throw new TypeError('A Browse-only session facade with browse() and browseNext() is required');
  }

  // Do not pass the full session anywhere else in the algorithm.
  const browse = session.browse.bind(session);
  const browseNext = session.browseNext.bind(session);
  const limits = normalizeLimits(limitOverrides);
  const startedAt = nowIso(clock);
  const startedMs = clock();
  const deadlineMs = startedMs + limits.maxDurationMs;
  const nodes = new Map();
  const queue = [];
  const pendingContinuationPoints = new Set();
  const errors = [];
  let browseRequests = 0;
  let referenceCount = 0;
  let duplicateCount = 0;
  let cycleCount = 0;
  let omittedPaths = 0;
  let outputBytes = 0;
  let suppressedErrors = 0;
  let truncated = false;
  let stopReason = null;
  let activeBrowsePromise = null;

  const recordError = error => {
    if (errors.length < limits.maxErrors) errors.push(error);
    else suppressedErrors += 1;
  };

  for (const root of roots) {
    const id = nodeIdText(root?.nodeId);
    if (!id) {
      errors.push({ stage: 'ROOT_VALIDATION', reason: 'INVALID_ROOT_NODE_ID' });
      continue;
    }
    const label = String(root.name || id);
    queue.push({ nodeId: id, depth: 0, path: [label], ancestry: [id], rootNodeId: id });
  }

  const hitGlobalLimit = () => {
    if (signal?.aborted) return 'BROWSE_CANCELLED';
    if (clock() >= deadlineMs) return 'MAX_DURATION';
    if (browseRequests >= limits.maxBrowseRequests) return 'MAX_BROWSE_REQUESTS';
    return null;
  };

  const call = async (method, args, label, cleanup = false) => {
    const globalLimit = cleanup ? null : hitGlobalLimit();
    if (globalLimit) throw Object.assign(new Error(globalLimit), { code: globalLimit });
    browseRequests += 1;
    if (!cleanup && signal?.aborted) throw Object.assign(new Error('Browse cancelled'), { code: 'BROWSE_CANCELLED' });
    const actual = Promise.resolve().then(() => method(...args));
    let settled = false;
    const markSettled = () => {
      settled = true;
      if (activeBrowsePromise === actual) activeBrowsePromise = null;
    };
    actual.then(markSettled, markSettled);
    activeBrowsePromise = actual;
    const timeout = cleanup ? limits.requestTimeoutMs : Math.min(limits.requestTimeoutMs, Math.max(1, deadlineMs - clock()));
    const deadline = makeTimeout(timeout, cleanup ? null : signal, label, cleanup);
    try {
      const result = await Promise.race([actual, deadline.promise]);
      if (activeBrowsePromise === actual) activeBrowsePromise = null;
      return result;
    } catch (error) {
      if (settled && activeBrowsePromise === actual) activeBrowsePromise = null;
      throw error;
    } finally {
      deadline.cancel();
    }
  };

  const addReference = (reference, parent) => {
    referenceCount += 1;
    const record = referenceRecord(reference, parent.nodeId, parent.path, parent.depth + 1);
    if (!record) {
      recordError({ stage: 'REFERENCE_NORMALIZATION', parentNodeId: parent.nodeId, reason: 'MISSING_NODE_ID' });
      return;
    }
    const prior = nodes.get(record.nodeId);
    const isCycle = parent.ancestry.includes(record.nodeId);
    const pathRecord = {
      parentNodeId: parent.nodeId,
      rootNodeId: parent.rootNodeId,
      hierarchicalPath: record.hierarchicalPath,
      cycle: isCycle,
    };
    if (isCycle) cycleCount += 1;
    if (prior) {
      duplicateCount += 1;
      if (prior.paths.length < limits.maxPathsPerNode) {
        const candidateBytes = Buffer.byteLength(JSON.stringify(pathRecord), 'utf8');
        if (outputBytes + candidateBytes > limits.maxBytes) {
          truncated = true; stopReason = 'MAX_BYTES'; return;
        }
        prior.paths.push(pathRecord);
        outputBytes += candidateBytes;
      } else omittedPaths += 1;
    } else {
      const nodeRecord = { ...record, paths: [pathRecord] };
      const candidateBytes = Buffer.byteLength(JSON.stringify(nodeRecord), 'utf8');
      if (nodes.size >= limits.maxNodes) { truncated = true; stopReason = 'MAX_NODES'; return; }
      if (outputBytes + candidateBytes > limits.maxBytes) { truncated = true; stopReason = 'MAX_BYTES'; return; }
      nodes.set(record.nodeId, nodeRecord);
      outputBytes += candidateBytes;
    }
    if (!isCycle && parent.depth + 1 < limits.maxDepth) {
      queue.push({
        nodeId: record.nodeId,
        depth: parent.depth + 1,
        path: record.hierarchicalPath,
        ancestry: [...parent.ancestry, record.nodeId],
        rootNodeId: parent.rootNodeId,
      });
    }
  };

  const releaseAllContinuationPoints = async () => {
    // Never overlap Browse requests. If a timed-out request is still unresolved,
    // the owner must close the session; issuing BrowseNext concurrently is unsafe.
    if (activeBrowsePromise) {
      recordError({ stage: 'CONTINUATION_RELEASE', reason: 'DEFERRED_ACTIVE_BROWSE_MUST_BE_ABORTED_BY_SESSION_OWNER', count: pendingContinuationPoints.size });
      return;
    }
    for (const point of [...pendingContinuationPoints]) {
      try {
        await call(browseNext, [point, true], 'BrowseNext release', true);
      } catch (error) {
        recordError({ stage: 'CONTINUATION_RELEASE', reason: safeError(error).message });
      } finally {
        pendingContinuationPoints.delete(point);
      }
    }
  };

  try {
    while (queue.length && !truncated) {
      const parent = queue.shift();
      if (parent.depth >= limits.maxDepth) continue;
      let page;
      try {
        page = await call(browse, [{
          nodeId: parent.nodeId,
          browseDirection: 0, // BrowseDirection.Forward
          referenceTypeId: HIERARCHICAL_REFERENCES,
          includeSubtypes: true,
          nodeClassMask: 0,
          resultMask: BROWSE_RESULT_MASK,
          requestedMaxReferencesPerNode: limits.maxReferencesPerNode,
        }], 'Browse');
      } catch (error) {
        const reason = safeError(error);
        recordError({ stage: 'BROWSE', nodeId: parent.nodeId, depth: parent.depth, ...reason });
        if (['MAX_DURATION', 'MAX_BROWSE_REQUESTS', 'BROWSE_CANCELLED', 'BROWSE_TIMEOUT'].includes(error?.code)) {
          stopReason = error.code;
          truncated = true;
        }
        continue;
      }

      const browseStatus = statusText(page?.statusCode);
      if (browseStatus && !/^Good(?:\b|\s|\()/i.test(browseStatus)) {
        recordError({ stage: 'BROWSE', nodeId: parent.nodeId, depth: parent.depth, statusCode: browseStatus });
        continue;
      }

      let point = continuationPoint(page);
      if (point) pendingContinuationPoints.add(point);
      if (signal?.aborted) { truncated = true; stopReason = 'BROWSE_CANCELLED'; }
      let currentPage = page;
      while (currentPage) {
        for (const reference of currentPage.references || []) {
          addReference(reference, parent);
          if (truncated) break;
        }
        if (truncated || !point) break;
        if (hitGlobalLimit()) {
          const reason = hitGlobalLimit();
          truncated = true; stopReason = reason;
          break;
        }
        try {
          currentPage = await call(browseNext, [point, false], 'BrowseNext');
        } catch (error) {
          recordError({ stage: 'BROWSE_NEXT', nodeId: parent.nodeId, depth: parent.depth, ...safeError(error) });
          currentPage = null;
          truncated = true;
          stopReason = error?.code || 'BROWSE_NEXT_ERROR';
          break;
        }
        pendingContinuationPoints.delete(point);
        point = continuationPoint(currentPage);
        if (point) pendingContinuationPoints.add(point);
        const nextStatus = statusText(currentPage?.statusCode);
        if (nextStatus && !/^Good(?:\b|\s|\()/i.test(nextStatus)) {
          recordError({ stage: 'BROWSE_NEXT', nodeId: parent.nodeId, depth: parent.depth, statusCode: nextStatus });
          currentPage = null;
          truncated = true;
          stopReason = 'BROWSE_NEXT_BAD_STATUS';
          break;
        }
      }
    }
  } catch (error) {
    recordError({ stage: 'EXPLORATION', ...safeError(error) });
    stopReason ||= error?.code || 'UNEXPECTED_ERROR';
    truncated = true;
  } finally {
    await releaseAllContinuationPoints();
  }

  const finishedAt = nowIso(clock);
  const nodeList = [...nodes.values()];
  const document = {
    schemaVersion: '1.0',
    cpsId: 'cpslai3',
    formalCpsId: 'CPS-LAI-03',
    station: 'Sorting Station',
    discoveryMode: 'OPC_UA_BROWSE_ONLY',
    startedAt,
    finishedAt,
    durationMs: Math.max(0, clock() - startedMs),
    limits,
    roots: roots.map(root => ({ nodeId: nodeIdText(root.nodeId), name: String(root.name || root.nodeId) })),
    statistics: {
      browseRequests,
      uniqueNodeCount: nodes.size,
      referenceCount,
      duplicateCount,
      cycleCount,
      omittedPaths,
      errorCount: errors.length,
      suppressedErrorCount: suppressedErrors,
      outputBytes,
      truncated,
      stopReason,
      sessionCloseRequired: Boolean(activeBrowsePromise),
    },
    errors,
    nodes: nodeList,
  };
  const refreshExports = () => {
    document.statistics.outputBytes = document.nodes.reduce((bytes, node) =>
      bytes + Buffer.byteLength(`${JSON.stringify({ recordType: 'node', ...node })}\n`, 'utf8'), 0);
    return { json: JSON.stringify(document, null, 2), jsonl: serializeJsonl(document) };
  };
  let exports = refreshExports();
  while (Math.max(Buffer.byteLength(exports.json, 'utf8'), Buffer.byteLength(exports.jsonl, 'utf8')) > limits.maxBytes && document.nodes.length) {
    document.nodes.pop();
    document.statistics.uniqueNodeCount = document.nodes.length;
    document.statistics.truncated = true;
    document.statistics.stopReason = 'MAX_BYTES_DOCUMENT_ENVELOPE';
    exports = refreshExports();
  }
  while (Math.max(Buffer.byteLength(exports.json, 'utf8'), Buffer.byteLength(exports.jsonl, 'utf8')) > limits.maxBytes && document.errors.length) {
    document.errors.pop();
    document.statistics.suppressedErrorCount += 1;
    document.statistics.errorCount = document.errors.length;
    document.statistics.truncated = true;
    document.statistics.stopReason ||= 'MAX_BYTES_ERROR_LOG';
    exports = refreshExports();
  }
  exports = refreshExports();
  return {
    document,
    ...exports,
    // Allows the lifecycle owner to wait for a request whose explorer-level
    // timeout/cancel fired before node-opcua's transaction timeout settled it.
    settlePending: async () => {
      const pending = activeBrowsePromise;
      if (pending) await pending.catch(() => {});
      return { settled: !activeBrowsePromise };
    },
  };
}

/** Minimal future Node-RED integration: expose only Browse service methods. */
export function createBrowseOnlyFacade(session) {
  if (!session || typeof session.browse !== 'function' || typeof session.browseNext !== 'function') {
    throw new TypeError('node-opcua session must provide browse() and browseNext()');
  }
  return Object.freeze({
    browse: (...args) => session.browse(...args),
    browseNext: (...args) => session.browseNext(...args),
  });
}
