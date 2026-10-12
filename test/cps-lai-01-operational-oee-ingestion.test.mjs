import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../context/CPSContext.js', import.meta.url), 'utf8');
const helperMatch = source.match(
  /const isCurrentCpsLai1OperationalOee = \(\{ topic, payload, normalized, owner \}\) => \{([\s\S]*?)\n\};/
);
assert.ok(helperMatch, 'CPS-LAI-01 operational OEE validator must exist');

const normalizeId = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const normalizeTopic = (value) => String(value || '').trim().replace(/^\/+|\/+$/g, '').toLowerCase();
const canonicalOperationMode = (value) => String(value || '').trim().toLowerCase();
const normalizeSnapshotTimestamp = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
};
const toNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
const isCpsInPlay = (owner) => String(owner?.lifecyclePhase || '').toLowerCase() === 'play';
const validate = new Function(
  'normalizeTopic', 'normalizeCpsId', 'canonicalOperationMode', 'normalizeSnapshotTimestamp',
  'toNumber', 'isCpsInPlay',
  `return ({ topic, payload, normalized, owner }) => {${helperMatch[1]}\n};`
)(normalizeTopic, normalizeId, canonicalOperationMode, normalizeSnapshotTimestamp, toNumber, isCpsInPlay);

const payload = {
  cpsId: 'cpslai1',
  timestamp: '2026-10-12T13:10:14.706Z',
  calculationState: 'OPERATIONAL_OEE_PROXY',
  oee: { current: 0.015264810455639478, availability: 0.10264073664045703, performance: 0.14872078041597644, quality: 1 },
  evidenceStatus: 'SENSOR_DERIVED_OPERATIONAL_OEE',
  time: { runTimeMs: 1000, stoppedTimeMs: 2000 },
  reference: { cycleTimeMs: 2020, evidenceStatus: 'EXPERIMENTAL_REFERENCE_PROVISIONAL' },
  evidence: { countSourceTag: 'G1BG1' },
};
const normalized = { ...payload, oee: { ...payload.oee } };

for (const operationalState of ['running', 'stopped', 'maintenance', 'unknown']) {
  test(`accepts current physical operational OEE while CPS-LAI-01 is ${operationalState}`, () => {
    assert.equal(validate({
      topic: 'cpslai1/oee', payload, normalized,
      owner: { id: 'cpslai1', lifecyclePhase: 'play', operationalState },
    }), true);
  });
}

test('rejects incompatible cpsId, wrong calculation state, invalid fractions and disconnected owner', () => {
  const owner = { id: 'cpslai1', lifecyclePhase: 'play', operationalState: 'running' };
  assert.equal(validate({ topic: 'cpslai1/oee', payload, normalized: { ...normalized, cpsId: 'cpslai2' }, owner }), false);
  assert.equal(validate({ topic: 'cpslai1/oee', payload, normalized: { ...normalized, calculationState: 'SYNTHETIC' }, owner }), false);
  assert.equal(validate({ topic: 'cpslai1/oee', payload, normalized: { ...normalized, oee: { ...normalized.oee, quality: 100 } }, owner }), false);
  assert.equal(validate({ topic: 'cpslai1/oee', payload, normalized, owner: { ...owner, operationalState: 'disconnected' } }), false);
  assert.equal(validate({ topic: 'cpslai1/oee', payload, normalized, owner: null }), false);
});

test('rejects messages without a producer timestamp and owners outside the current Play cycle', () => {
  assert.equal(validate({
    topic: 'cpslai1/oee', payload: { ...payload, timestamp: null }, normalized,
    owner: { id: 'cpslai1', lifecyclePhase: 'play', operationalState: 'unknown' },
  }), false);
  assert.equal(validate({
    topic: 'cpslai1/oee', payload, normalized,
    owner: { id: 'cpslai1', lifecyclePhase: 'unplug', operationalState: 'unknown' },
  }), false);
});

test('timestamp ordering, metadata preservation and cognitive gate remain explicit in the OEE branch', () => {
  assert.match(source, /if \(!isNewerSnapshot\(parsed\?\.ts \?\? parsed\?\.timestamp, currentOeeTimestamp\)\) return;/);
  assert.match(source, /if \(!isOperationalCpsLai1Oee && !ownerCanIngestCognitivePayload\)/);
  assert.match(source, /if \(isCpsLai1OeeTopic && !isOperationalCpsLai1Oee\) return;/);
  assert.match(source, /operationalEnvelope: isOperationalCpsLai1Oee/);
  for (const field of ['calculationState', 'evidenceStatus', 'timestamp', 'time', 'reference', 'performanceEvidence', 'qualityEvidence', 'evidence', 'note']) {
    assert.match(source, new RegExp(`\\b${field}:`));
  }
  const learningBranch = source.slice(source.indexOf("if (topic.endsWith('/learning'))"));
  assert.match(learningBranch, /if \(!ownerCanIngestCognitivePayload\)/);
});

test('synthetic CPS-LAI-02/03 routing remains isolated and unchanged', () => {
  assert.match(source, /'cpslai2\/synthetic-oee': 'oee'/);
  assert.match(source, /'cpslai3\/synthetic-oee': 'oee'/);
  assert.doesNotMatch(source, /'cpslai1\/synthetic-oee': 'oee'/);
});
