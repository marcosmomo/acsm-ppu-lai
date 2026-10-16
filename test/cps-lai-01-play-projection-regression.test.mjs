import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { applyPhysicalStatus } from '../lib/acsm/cpsOperationMode.mjs';

const contextSource = readFileSync(new URL('../context/CPSContext.js', import.meta.url), 'utf8');
const playSource = readFileSync(new URL('../components/PlayFase.js', import.meta.url), 'utf8');

test('CPS-LAI-01 data ingestion gates on RUNNING state, independently from AUTOMATIC mode', () => {
  assert.match(
    contextSource,
    /const isCpsOperationallyRunning = \(cps\) =>\s*isCpsInPlay\(cps\) && getCanonicalOperationalState\(cps\) === 'running'/
  );
  assert.doesNotMatch(
    contextSource,
    /const isCpsOperationallyRunning = \(cps\) =>\s*isCpsInPlay\(cps\) && normalizeOperationMode\(cps\) === 'running'/
  );
});

test('a CPS-LAI-01 status update preserves operational telemetry while updating its physical mode', () => {
  const currentCps = {
    id: 'cpslai1',
    operationalState: 'running',
    operationalData: {
      operationMode: 'MANUAL',
      PieceAtEntry: true,
      PieceAtMiddle: false,
      PieceAtExit: true,
      SlideRetracted: false,
      SlideExtended: true,
      AlarmSignal: false,
    },
  };

  const nextOperationalData = applyPhysicalStatus(currentCps, {
    operationalState: 'RUNNING',
    operationMode: 'AUTOMATIC',
  });

  assert.equal(nextOperationalData.operationMode, 'AUTOMATIC');
  assert.equal(nextOperationalData.PieceAtEntry, true);
  assert.equal(nextOperationalData.PieceAtExit, true);
  assert.equal(nextOperationalData.SlideExtended, true);
  assert.equal(nextOperationalData.AlarmSignal, false);
  assert.match(
    contextSource,
    /isCpsLai1Status\s*\? \{ operationalData: applyPhysicalStatus\(c, data\) \}\s*:\s*\{\}/
  );
});

test('Play Phase consumes the shared operational analytics snapshot without manufacturing zeroes', () => {
  assert.match(playSource, /cpsAnalytics,/);
  assert.match(playSource, /const operationalAnalytics = cpsAnalytics\?\.\[normalizedCpsId\] \|\| null/);
  assert.match(playSource, /operationalAnalytics\?\.oee\?\.availability \?\? null/);
  assert.match(playSource, /cps\?\.production \|\| operationalAnalytics\?\.production \|\| null/);
  assert.doesNotMatch(playSource, /operationalAnalytics\?\.oee\?\.(?:oee|availability|performance|quality) \?\? 0/);
});

test('Global OEE remains evidence-based and reuses only available local OEE snapshots', () => {
  assert.match(playSource, /const analyticsOee = cpsAnalytics\?\.\[cpsId\]\?\.oee/);
  assert.match(playSource, /if \(!validOees\.length\) \{[\s\S]*?value: null/);
  assert.doesNotMatch(playSource, /if \(!validOees\.length\) \{[\s\S]*?value: 0/);
});
