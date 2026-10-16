import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PlugCycleReservationStore } from '../lib/acsm/plugCycleReservationStore.mjs';

async function isolated(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acsm-plug-reservation-'));
  const filePath = path.join(root, 'reservation.json');
  try { return await run({ root, filePath, store: new PlugCycleReservationStore({ filePath }) }); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}
const ids = (reservation) => ({ cpsId: reservation.cpsId, plugEventId: reservation.plugEventId, plugCycleId: reservation.plugCycleId });

test('first Plug reserves without approval and retry returns the same cycle', () => isolated(({ store }) => {
  const first = store.reserve({ cpsId: 'CPS-LAI-01', plugEventId: 'event-1', identity: { aasId: 'aas-1' } });
  const retry = store.reserve({ cpsId: 'cpslai1', plugEventId: 'event-1', identity: { aasId: 'aas-1' } });
  assert.equal(first.reservation.state, 'RESERVED');
  assert.equal(retry.reservation.plugCycleId, first.reservation.plugCycleId);
  assert.equal(retry.idempotent, true);
  assert.equal(JSON.stringify(store.read()).includes('APPROVED'), false);
}));

test('different event cannot replace RESERVED, ACTIVE or FAILED cycle', () => isolated(({ store }) => {
  const first = store.reserve({ cpsId: 'cps1', plugEventId: 'event-1' }).reservation;
  assert.throws(() => store.reserve({ cpsId: 'cps1', plugEventId: 'event-2' }), { code: 'PLUG_CYCLE_CONFLICT' });
  store.activate(ids(first));
  assert.throws(() => store.reserve({ cpsId: 'cps1', plugEventId: 'event-2' }), { code: 'PLUG_CYCLE_CONFLICT' });
  store.recordFailure({ ...ids(first), stage: 'AFTER_PROFILE', error: new Error('downstream failed') });
  assert.throws(() => store.reserve({ cpsId: 'cps1', plugEventId: 'event-2' }), { code: 'PLUG_CYCLE_CONFLICT' });
  assert.equal(store.read().cycles[0].failure.stage, 'AFTER_PROFILE');
}));

test('restart recovers reservation and close is bound to exact Unplug cycle', () => isolated(({ filePath, store }) => {
  const first = store.reserve({ cpsId: 'cps1', plugEventId: 'event-1' }).reservation;
  store.activate({ ...ids(first), governanceProfileId: 'profile-v7', governanceProfileVersion: 7 });
  const restarted = new PlugCycleReservationStore({ filePath });
  assert.equal(restarted.reserve({ cpsId: 'cps1', plugEventId: 'event-1' }).reservation.plugCycleId, first.plugCycleId);
  assert.throws(() => restarted.close({ cpsId: 'cps1', plugEventId: 'wrong', plugCycleId: first.plugCycleId, evidence: { source: 'test' } }), { code: 'PLUG_CYCLE_IDENTITY_CONFLICT' });
  restarted.close({ ...ids(first), evidence: { source: 'verified-unplug', transitionId: 'unplug-1' } });
  const second = restarted.reserve({ cpsId: 'cps1', plugEventId: 'event-2' }).reservation;
  assert.notEqual(second.plugCycleId, first.plugCycleId);
  restarted.activate({ ...ids(second), governanceProfileId: 'profile-v8', governanceProfileVersion: 8 });
  const persisted = restarted.read();
  assert.equal(persisted.cycles[0].governanceProfileVersion, 7);
  assert.equal(persisted.cycles[0].state, 'CLOSED');
  assert.equal(persisted.cycles[1].governanceProfileVersion, 8);
}));

test('plugEventId cannot be rebound to another CPS or identity', () => isolated(({ store }) => {
  store.reserve({ cpsId: 'cps1', plugEventId: 'event-1', identity: { aasId: 'aas-1' } });
  assert.throws(() => store.reserve({ cpsId: 'cps2', plugEventId: 'event-1', identity: { aasId: 'aas-1' } }), { code: 'PLUG_EVENT_IDENTITY_CONFLICT' });
  assert.throws(() => store.reserve({ cpsId: 'cps1', plugEventId: 'event-1', identity: { aasId: 'aas-2' } }), { code: 'PLUG_EVENT_IDENTITY_CONFLICT' });
}));

test('persistence failure is explicit and leaves no committed reservation', () => isolated(({ filePath }) => {
  const store = new PlugCycleReservationStore({ filePath, faultInjector(stage) { if (stage === 'beforeRename') throw new Error('disk full'); } });
  assert.throws(() => store.reserve({ cpsId: 'cps1', plugEventId: 'event-1' }), { code: 'PLUG_RESERVATION_WRITE_FAILED' });
  assert.equal(fs.existsSync(filePath), false);
  assert.equal(fs.existsSync(`${filePath}.lock`), false);
}));

test('orphan lock is never auto-released and requires explicit verified recovery', () => isolated(({ filePath }) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.mkdirSync(`${filePath}.lock`);
  fs.writeFileSync(path.join(`${filePath}.lock`, 'owner.json'), JSON.stringify({ pid: 999999, acquiredAt: '2000-01-01T00:00:00.000Z' }));
  const store = new PlugCycleReservationStore({ filePath, lockTimeoutMs: 15, retryMs: 2 });
  assert.throws(() => store.reserve({ cpsId: 'cps1', plugEventId: 'event-1' }), { code: 'PLUG_RESERVATION_BUSY' });
  assert.throws(() => store.releaseOrphanedLock({ verified: false, reason: 'old' }), { code: 'PLUG_LOCK_VERIFICATION_REQUIRED' });
  assert.equal(store.releaseOrphanedLock({ verified: true, reason: 'process absence and real state verified in test' }).released, true);
}));

test('two distinct processes cannot create competing cycles', () => isolated(async ({ root, filePath }) => {
  const startFile = path.join(root, 'start');
  const worker = path.resolve('test/fixtures/plug-reservation-worker.mjs');
  const run = (eventId) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, filePath, 'cps1', eventId, startFile], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; }); child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', reject); child.on('close', (code) => code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err)));
  });
  const children = [run('event-A'), run('event-B')];
  fs.writeFileSync(startFile, 'go');
  const results = await Promise.all(children);
  assert.equal(results.filter((item) => item.ok).length, 1);
  assert.ok(['PLUG_CYCLE_CONFLICT', 'PLUG_RESERVATION_BUSY'].includes(results.find((item) => !item.ok).code));
  const cycles = new PlugCycleReservationStore({ filePath }).read().cycles;
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0].state, 'RESERVED');
}));

test('two distinct processes retrying the same event recover one cycle', () => isolated(async ({ root, filePath }) => {
  const startFile = path.join(root, 'start');
  const worker = path.resolve('test/fixtures/plug-reservation-worker.mjs');
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, filePath, 'cps1', 'same-event', startFile], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; }); child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', reject); child.on('close', (code) => code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err)));
  });
  const children = [run(), run()];
  fs.writeFileSync(startFile, 'go');
  const results = await Promise.all(children);
  assert.equal(results.every((item) => item.ok), true);
  assert.equal(results[0].result.reservation.plugCycleId, results[1].result.reservation.plugCycleId);
  assert.equal(new PlugCycleReservationStore({ filePath }).read().cycles.length, 1);
}));
