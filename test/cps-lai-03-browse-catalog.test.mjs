import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createBrowseOnlyFacade,
  discoverCpsLai3BrowseCatalog,
  DEFAULT_BROWSE_LIMITS,
} from '../lib/opcua/cpsLai3BrowseCatalog.mjs';

const ref = (nodeId, browseName, nodeClass = 1) => ({
  nodeId,
  browseName: { name: browseName, namespaceIndex: 3 },
  displayName: { text: browseName, locale: 'en' },
  nodeClass,
  referenceTypeId: 'ns=0;i=47',
  isForward: true,
  typeDefinition: { nodeId: 'ns=0;i=58' },
});
const goodPage = (references = [], continuationPoint = null) => ({ statusCode: 'Good', references, continuationPoint });
const run = (session, options = {}) => discoverCpsLai3BrowseCatalog({
  session,
  roots: [{ nodeId: 'ns=3;s=Root', name: 'Root' }],
  limits: { ...DEFAULT_BROWSE_LIMITS, maxDurationMs: 10_000, requestTimeoutMs: 100, ...options.limits },
  ...options,
});

function mockSession(handlers = {}) {
  const calls = [];
  const session = {
    async browse(description) {
      calls.push({ method: 'browse', args: [description] });
      return handlers.browse ? handlers.browse(description, calls) : goodPage();
    },
    async browseNext(point, release) {
      calls.push({ method: 'browseNext', args: [point, release] });
      return handlers.browseNext ? handlers.browseNext(point, release, calls) : goodPage();
    },
    async read() { throw new Error('FORBIDDEN_READ_CALLED'); },
    async write() { throw new Error('FORBIDDEN_WRITE_CALLED'); },
    async call() { throw new Error('FORBIDDEN_CALL_CALLED'); },
    async createSubscription() { throw new Error('FORBIDDEN_SUBSCRIBE_CALLED'); },
  };
  return { session, calls };
}

test('facade exposes only browse and browseNext; exploration never calls forbidden OPC UA services', async () => {
  const { session, calls } = mockSession({
    browse: () => goodPage([ref('ns=3;s=A', 'A', 2)]),
    browseNext: () => goodPage(),
  });
  const facade = createBrowseOnlyFacade(session);
  assert.deepEqual(Object.keys(facade).sort(), ['browse', 'browseNext']);
  const result = await run(facade);
  assert.equal(result.document.nodes.length, 1);
  assert.deepEqual([...new Set(calls.map(call => call.method))].sort(), ['browse']);
  assert.equal(calls.some(call => ['read', 'write', 'call', 'createSubscription'].includes(call.method)), false);
});

test('paginates with BrowseNext, serializes structural fields and releases outstanding points', async () => {
  let rootBrowseCount = 0;
  let nextCount = 0;
  const { session, calls } = mockSession({
    browse: description => {
      if (description.nodeId !== 'ns=3;s=Root') return goodPage();
      rootBrowseCount += 1;
      return rootBrowseCount === 1
        ? goodPage([ref('ns=3;s=A', 'A')], Buffer.from('cp-1'))
        : goodPage();
    },
    browseNext: (_point, release) => {
      if (release) return goodPage();
      nextCount += 1;
      return nextCount === 1
        ? goodPage([ref('ns=3;s=B', 'B', 2)], Buffer.from('cp-2'))
        : goodPage();
    },
  });
  const result = await run(session);
  assert.deepEqual(result.document.nodes.map(node => node.nodeId), ['ns=3;s=A', 'ns=3;s=B']);
  assert.equal(result.document.nodes[0].parentNodeId, 'ns=3;s=Root');
  assert.deepEqual(result.document.nodes[1].hierarchicalPath, ['Root', 'B']);
  assert.equal(result.document.nodes[0].nodeClass, 'Object');
  assert.equal(result.document.discoveryMode, 'OPC_UA_BROWSE_ONLY');
  assert.ok(result.jsonl.includes('"referenceTypeId":"ns=0;i=47"'));
  assert.equal(JSON.parse(result.jsonl.trim().split('\n')[0]).recordType, 'run');
  assert.deepEqual(calls.map(call => call.method), ['browse', 'browseNext', 'browseNext', 'browse', 'browse']);
  assert.equal(calls[1].args[1], false);
  assert.equal(calls[2].args[1], false, 'the returned continuation point is consumed');
});

test('releases an unconsumed continuation point when a configured cap stops traversal', async () => {
  const { session, calls } = mockSession({
    browse: () => goodPage([ref('ns=3;s=A', 'A'), ref('ns=3;s=B', 'B')], Buffer.from('cp-release')),
    browseNext: () => goodPage(),
  });
  const result = await run(session, { limits: { maxNodes: 1 } });
  assert.equal(result.document.statistics.stopReason, 'MAX_NODES');
  assert.ok(calls.some(call => call.method === 'browseNext' && call.args[1] === true));
  assert.equal(result.json.includes('cp-release'), false);
});

test('deduplicates NodeIds, preserves distinct paths, and prevents cycles', async () => {
  const graph = {
    'ns=3;s=Root': [ref('ns=3;s=A', 'A'), ref('ns=3;s=B', 'B')],
    'ns=3;s=A': [ref('ns=3;s=Shared', 'Shared'), ref('ns=3;s=Root', 'RootLoop')],
    'ns=3;s=B': [ref('ns=3;s=Shared', 'Shared')],
    'ns=3;s=Shared': [],
  };
  const { session } = mockSession({ browse: description => goodPage(graph[description.nodeId] || []) });
  const result = await run(session);
  const shared = result.document.nodes.find(node => node.nodeId === 'ns=3;s=Shared');
  assert.equal(result.document.nodes.filter(node => node.nodeId === 'ns=3;s=Shared').length, 1);
  assert.equal(shared.paths.length, 2);
  assert.equal(result.document.statistics.duplicateCount, 1);
  assert.equal(result.document.statistics.cycleCount, 1);
  assert.ok(result.document.nodes.find(node => node.nodeId === 'ns=3;s=Root').paths[0].cycle);
});

test('records Browse errors and continues with other roots/nodes', async () => {
  const { session } = mockSession({
    browse: description => description.nodeId === 'ns=3;s=Root'
      ? { statusCode: 'Bad_NodeIdUnknown', references: [] }
      : goodPage([ref('ns=3;s=Child', 'Child')]),
  });
  const result = await discoverCpsLai3BrowseCatalog({
    session,
    roots: [{ nodeId: 'ns=3;s=Root', name: 'Root' }, { nodeId: 'ns=3;s=Other', name: 'Other' }],
  });
  assert.ok(result.document.errors.some(error => error.statusCode === 'Bad_NodeIdUnknown'));
  assert.ok(result.document.nodes.some(node => node.nodeId === 'ns=3;s=Child'));
});

test('stops and releases the point after BrowseNext errors; redacts sensitive error fragments', async () => {
  const { session, calls } = mockSession({
    browse: () => goodPage([ref('ns=3;s=A', 'A')], Buffer.from('must-not-log')),
    browseNext: (_point, release) => {
      if (release) return goodPage();
      throw new Error('socket https://user:private@host/path?token=private-token');
    },
  });
  const result = await run(session);
  assert.equal(result.document.statistics.truncated, true);
  assert.equal(result.document.statistics.stopReason, 'BROWSE_NEXT_ERROR');
  assert.ok(calls.some(call => call.method === 'browseNext' && call.args[1] === true));
  assert.equal(result.json.includes('private-token'), false);
  assert.equal(result.json.includes('user:private'), false);
  assert.equal(result.json.includes('must-not-log'), false);
});

test('enforces depth, node and request limits', async () => {
  const chain = (description) => {
    const match = description.nodeId.match(/;s=N(\d+)$/);
    const number = match ? Number(match[1]) : 0;
    return goodPage([ref(`ns=3;s=N${number + 1}`, `N${number + 1}`)]);
  };
  const maxDepth = await run(mockSession({ browse: chain }).session, { limits: { maxDepth: 2 } });
  assert.equal(maxDepth.document.nodes.length, 2);
  const maxNodes = await run(mockSession({ browse: () => goodPage([ref('ns=3;s=A', 'A'), ref('ns=3;s=B', 'B')]) }).session, { limits: { maxNodes: 1 } });
  assert.equal(maxNodes.document.nodes.length, 1);
  assert.equal(maxNodes.document.statistics.stopReason, 'MAX_NODES');
  const maxRequests = await run(mockSession({ browse: () => goodPage([ref('ns=3;s=A', 'A')]) }).session, { limits: { maxBrowseRequests: 1 } });
  assert.equal(maxRequests.document.statistics.browseRequests, 1);
  assert.equal(maxRequests.document.statistics.stopReason, 'MAX_BROWSE_REQUESTS');
});

test('enforces a maximum wall-clock duration', async () => {
  let time = 0;
  const { session } = mockSession({ browse: () => { time += 100; return goodPage([ref('ns=3;s=A', 'A')]); } });
  const result = await discoverCpsLai3BrowseCatalog({
    session,
    roots: [{ nodeId: 'ns=3;s=Root', name: 'Root' }],
    limits: { maxDurationMs: 50, requestTimeoutMs: 200 },
    clock: () => time,
  });
  assert.equal(result.document.statistics.stopReason, 'MAX_DURATION');
  assert.equal(result.document.statistics.truncated, true);
});

test('applies byte cap and returns syntactically valid JSON/JSONL', async () => {
  const many = Array.from({ length: 20 }, (_, index) => ref(`ns=3;s=V${index}`, `LongVariableName${index}`));
  const result = await run(mockSession({ browse: () => goodPage(many) }).session, { limits: { maxBytes: 4096 } });
  assert.ok(Buffer.byteLength(result.json, 'utf8') <= 4096);
  assert.ok(Buffer.byteLength(result.jsonl, 'utf8') <= 4096);
  assert.doesNotThrow(() => JSON.parse(result.json));
  for (const line of result.jsonl.trim().split('\n').filter(Boolean)) assert.doesNotThrow(() => JSON.parse(line));
});

test('handles cancellation and timeout without logging continuation points', async () => {
  const controller = new AbortController();
  const { session, calls } = mockSession({
    browse: () => {
      const page = { statusCode: 'Good', continuationPoint: Buffer.from('SECRET-CONTINUATION') };
      Object.defineProperty(page, 'references', {
        get() {
          controller.abort();
          return [ref('ns=3;s=A', 'A')];
        },
      });
      return page;
    },
    browseNext: () => goodPage(),
  });
  const cancelled = await run(session, { signal: controller.signal });
  assert.equal(cancelled.document.statistics.stopReason, 'BROWSE_CANCELLED');
  assert.ok(calls.some(call => call.method === 'browseNext' && call.args[1] === true));
  assert.equal(cancelled.json.includes('SECRET-CONTINUATION'), false);

  const timeoutSession = mockSession({ browse: () => new Promise(() => {}) }).session;
  const timedOut = await run(timeoutSession, { limits: { requestTimeoutMs: 10 } });
  assert.ok(timedOut.document.errors.some(error => error.message?.includes('timed out')));
  assert.equal(timedOut.document.statistics.truncated, true);
});

test('does not serialize continuation points or credentials in JSON output', async () => {
  const { session } = mockSession({
    browse: () => goodPage([ref('ns=3;s=A', 'A')], Buffer.from('opaque-cp-value')),
  });
  const result = await run(session);
  assert.equal(result.json.includes('opaque-cp-value'), false);
  assert.equal(result.json.includes('password'), false);
  assert.equal(result.json.includes('token'), false);
});
