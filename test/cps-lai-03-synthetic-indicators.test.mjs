import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CPS_LAI3_SYNTHETIC_MAX_AGE_MS,
  formatSyntheticPercent,
  normalizeCpsSyntheticIndicator,
  normalizeCpsLai3SyntheticIndicator,
} from '../lib/acsm/cpsLai3SyntheticIndicators.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contextSource = fs.readFileSync(path.join(root, 'context', 'CPSContext.js'), 'utf8');
const playSource = fs.readFileSync(path.join(root, 'components', 'PlayFase.js'), 'utf8');

test('existing MQTT subscription infrastructure adds isolated synthetic topics for CPS-LAI-02 and CPS-LAI-03', () => {
  assert.match(contextSource, /usesSyntheticIndicators\s*=\s*\['cpslai2', 'cpslai3'\]\.includes\(normalizedCpsId\)/);
  assert.match(contextSource, /joinTopic\(baseNo, 'synthetic-oee'\)/);
  assert.match(contextSource, /joinTopic\(baseNo, 'synthetic-health'\)/);
  assert.match(contextSource, /'cpslai3\/synthetic-oee': 'oee'/);
  assert.match(contextSource, /'cpslai3\/synthetic-health': 'health'/);
  assert.match(contextSource, /'cpslai2\/synthetic-oee': 'oee'/);
  assert.match(contextSource, /'cpslai2\/synthetic-health': 'health'/);
  assert.match(contextSource, /CPS_SYNTHETIC_MAX_AGE_MS\);/);
  assert.match(playSource, /formatSyntheticPercent\(oeeValue\)/);
  assert.match(playSource, /formatSyntheticPercent\(healthScore\)/);
  assert.match(playSource, /syntheticOeePayload\?\.evidenceStatus/);
  assert.match(playSource, /syntheticHealthPayload\?\.evidenceStatus/);
  assert.match(playSource, /Último OEE — cálculo pausado/);
  assert.match(playSource, /usesSyntheticIndicators\s*=\s*isCpsLai2\s*\|\|\s*isCpsLai3/);
  assert.match(playSource, /healthUsesSynthetic\s*=\s*usesSyntheticIndicators\s*&&\s*syntheticHealthFresh/);
  assert.match(playSource, /const healthScore = healthUsesSynthetic/);
  assert.match(contextSource, /setTimeout\([\s\S]*CPS_SYNTHETIC_MAX_AGE_MS\)/);
});

test('shared normalizer accepts CPS-LAI-02 while enforcing cross-CPS isolation', () => {
  const now = Date.now();
  const payload = {
    cpsId: 'cpslai2', indicatorClass: 'SYNTHETIC', calculationState: 'SYNTHETIC',
    timestamp: new Date(now).toISOString(),
    oee: { current: 88.2, availability: 100, performance: 90, quality: 98, unit: 'percent' },
  };
  assert.ok(normalizeCpsSyntheticIndicator('oee', payload, now, CPS_LAI3_SYNTHETIC_MAX_AGE_MS, 'cpslai2'));
  assert.equal(normalizeCpsSyntheticIndicator('oee', payload, now, CPS_LAI3_SYNTHETIC_MAX_AGE_MS, 'cpslai3'), null);
  assert.equal(normalizeCpsLai3SyntheticIndicator('oee', payload, now), null);
});

test('numeric synthetic percent values remain percentages and are not multiplied again', () => {
  const timestamp = new Date().toISOString();
  const payload = {
    cpsId: 'cpslai3', indicatorClass: 'SYNTHETIC', calculationState: 'SYNTHETIC', timestamp,
    oee: { current: 52.5, availability: 75, performance: 70, quality: 100, unit: 'percent' },
  };
  const normalized = normalizeCpsLai3SyntheticIndicator('oee', payload, Date.now());
  assert.equal(normalized.payload, payload);
  assert.equal(normalized.payload.oee.current, 52.5);
  assert.equal(formatSyntheticPercent(normalized.payload.oee.current), '52.5%');
  assert.equal(formatSyntheticPercent(normalized.payload.oee.availability), '75.0%');
  const healthPayload = {
    cpsId: 'cpslai3', indicatorClass: 'SYNTHETIC', calculationState: 'SYNTHETIC', timestamp,
    health: { current: 87.2, score: 87.2, healthState: 'SYNTHETIC_HEALTHY', unit: 'percent' },
  };
  assert.equal(formatSyntheticPercent(normalizeCpsLai3SyntheticIndicator('health', healthPayload, Date.now()).payload.health.current), '87.2%');
});

test('NOT_COMPUTED payload keeps null values and its reason; formatter displays an em dash', () => {
  const timestamp = new Date().toISOString();
  const payload = {
    cpsId: 'cpslai3', indicatorClass: 'SYNTHETIC', calculationState: 'NOT_COMPUTED',
    evidenceStatus: 'INSUFFICIENT_OR_STALE_REAL_INPUTS', reason: 'MISSING_EXPERIMENTAL_METRICS', timestamp,
    oee: { current: null, availability: null, performance: null, quality: null, unit: 'percent' },
  };
  const normalized = normalizeCpsLai3SyntheticIndicator('oee', payload, Date.now());
  assert.equal(normalized.payload.reason, 'MISSING_EXPERIMENTAL_METRICS');
  assert.deepEqual(
    [normalized.payload.oee.current, normalized.payload.oee.availability, normalized.payload.oee.performance, normalized.payload.oee.quality],
    [null, null, null, null]
  );
  assert.equal(formatSyntheticPercent(normalized.payload.oee.current), '—');
  assert.equal(normalizeCpsLai3SyntheticIndicator('health', {
    ...payload,
    health: { current: null, score: null, healthState: 'NOT_COMPUTED', unit: 'percent' },
  }, Date.now()).payload.reason, 'MISSING_EXPERIMENTAL_METRICS');
  assert.equal(normalizeCpsLai3SyntheticIndicator('health', {
    cpsId: 'cpslai3', indicatorClass: 'SYNTHETIC', calculationState: 'SYNTHETIC', timestamp,
    health: { current: 87, score: 87 },
  }, Date.now()), null, 'values without an explicit percent unit are rejected');
});

test('HELD_LAST_VALUE is accepted as a fresh MQTT envelope without changing its calculation timestamp', () => {
  const now = Date.now();
  const calculatedAt = new Date(now - 60_000).toISOString();
  const payload = {
    cpsId: 'cpslai3', indicatorClass: 'SYNTHETIC', calculationState: 'HELD_LAST_VALUE',
    timestamp: new Date(now).toISOString(), calculatedAt, reason: 'MODE_STEP_BY_STEP_NOT_AUTOMATIC',
    currentMode: 'STEP_BY_STEP',
    oee: { current: 88.2, availability: 100, performance: 90, quality: 98, unit: 'percent' },
  };
  const normalized = normalizeCpsLai3SyntheticIndicator('oee', payload, now);
  assert.equal(normalized.payload.calculatedAt, calculatedAt);
  assert.equal(normalized.staleAt, now + CPS_LAI3_SYNTHETIC_MAX_AGE_MS);
});

test('stale, future-dated, wrong-CPS and out-of-range samples are rejected', () => {
  const now = Date.now();
  const base = {
    cpsId: 'cpslai3', indicatorClass: 'SYNTHETIC', calculationState: 'SYNTHETIC',
    timestamp: new Date(now).toISOString(),
    health: { current: 87, score: 87, healthState: 'SYNTHETIC_HEALTHY', unit: 'percent' },
  };
  assert.equal(normalizeCpsLai3SyntheticIndicator('health', { ...base, timestamp: new Date(now - CPS_LAI3_SYNTHETIC_MAX_AGE_MS - 1).toISOString() }, now), null);
  assert.equal(normalizeCpsLai3SyntheticIndicator('health', { ...base, timestamp: new Date(now + 1000).toISOString() }, now), null);
  assert.equal(normalizeCpsLai3SyntheticIndicator('health', { ...base, cpsId: 'cpslai2' }, now), null);
  assert.equal(normalizeCpsLai3SyntheticIndicator('health', { ...base, health: { ...base.health, current: 101 } }, now), null);
});
