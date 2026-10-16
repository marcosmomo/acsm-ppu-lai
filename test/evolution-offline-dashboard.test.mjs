import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import report from '../docs/experiments/e1-cpslai1/report.json' with { type: 'json' };
import { buildE1OfflineViewModel, renderE1OfflineHtml } from '../lib/evolution/e1OfflineDashboard.mjs';

const routePath = new URL('../app/experiments/evolution/route.js', import.meta.url);

test('view model derives scenarios and identifiers only from the retained E1 report', () => {
  const model = buildE1OfflineViewModel();
  assert.equal(model.source.cpsId, 'cpslai1');
  assert.equal(model.v1Capabilities.length, 5);
  assert.equal(model.v1Services.length, 13);
  assert.deepEqual(model.scenarios.map((item) => item.id), report.scenarios.map((item) => item.id));
  assert.equal(model.scenarios.find((item) => item.id === 'E1.3').differences[0].type, 'ADDED');
  assert.equal(model.scenarios.find((item) => item.id === 'E1.4').differences[0].type, 'REMOVED');
  assert.equal(model.scenarios.find((item) => item.id === 'E1.5').differences[0].type, 'CHANGED');
  assert.equal(model.scenarios.find((item) => item.id === 'E1.6-incomplete').classification, 'INDETERMINATE');
  assert.equal(model.scenarios.find((item) => item.id === 'E1.7').retry.status, 'NO_OP');
  assert.equal(model.scenarios.find((item) => item.id === 'E1.8').governance.currentProfileStatus, 'PENDING_APPROVAL');
  assert.equal(model.scenarios.find((item) => item.id === 'E1.8').governance.playBlocked, true);
  assert.equal(model.scenarios.find((item) => item.id === 'E1.8').hashes, null);
});

test('unknown and inapplicable fields remain distinguishable in the rendered report', () => {
  const html = renderE1OfflineHtml();
  assert.match(html, /Não informado no relatório/);
  assert.match(html, /Não aplicável neste cenário/);
  assert.match(html, /E1.8-plug-replug/); // sourced simulated profile identity
  assert.match(html, /GOV-CPSLAI1-004/);
  assert.match(html, /b5ca586f90662dbebf5d829d92c2e53d342301b1378fb4ed0223641091ade692/);
});

test('page offers scenario selection but contains no operational controls or network calls', () => {
  const html = renderE1OfflineHtml();
  for (const scenario of report.scenarios) assert.match(html, new RegExp(`value="${scenario.id}"`));
  assert.match(html, /addEventListener\('change'/);
  assert.doesNotMatch(html, /<button\b|<form\b|fetch\s*\(|XMLHttpRequest|WebSocket|EventSource|mqtt|opcua|\/api\//i);
  assert.doesNotMatch(html, /CPSContext|governanceStore|GovernanceRepository|TransactionalGovernance/);
});

test('route is a standalone GET-only HTML response without root React provider or mutation imports', async () => {
  const route = await readFile(routePath, 'utf8');
  assert.match(route, /export function GET\(\)/);
  assert.doesNotMatch(route, /export function (POST|PUT|PATCH|DELETE)\b/);
  assert.match(route, /text\/html/);
  assert.doesNotMatch(route, /CPSContext|governanceStore|Repository|mqtt|opcua|fetch\s*\(/i);
});
