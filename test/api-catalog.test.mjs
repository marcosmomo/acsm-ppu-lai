import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAcsmApiCatalog } from '../lib/acsm/apiCatalog.mjs';

test('catalog exposes exactly the supported read-only facades', () => {
  const catalog = buildAcsmApiCatalog();
  const endpoints = catalog.availableFacades.map((facade) => facade.endpoint);
  assert.deepEqual(endpoints, ['/api/acsm/plug', '/api/acsm/play']);
  assert.equal(catalog.availableFacades.every((facade) => facade.readOnly === true), true);
  assert.equal(catalog.availableFacades.every((facade) => facade.method === 'GET'), true);
  for (const absent of ['/api/acsm/stop', '/api/acsm/maintenance', '/api/acsm/return', '/api/acsm/unplug']) {
    assert.equal(endpoints.includes(absent), false);
  }
});

test('catalog documents every lifecycle operation without a facade', () => {
  const catalog = buildAcsmApiCatalog();
  assert.deepEqual(Object.keys(catalog.lifecycleOperations), ['stop', 'maintenance', 'return', 'unplug']);
  assert.equal(
    Object.values(catalog.lifecycleOperations).every((operation) => operation.dedicatedFacade === false),
    true
  );
});
