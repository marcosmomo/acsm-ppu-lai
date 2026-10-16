import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PPU_TOPIC, validateMessage } from '../services/cps-lai-01-persistence/src/contracts.js';
import {
  buildGovernanceDecisionPpuEvent,
  buildPlugRequestedPpuEvent,
  buildPpuEvent,
} from '../lib/acsm/ppuEventBuilder.mjs';
import {
  approveGovernanceProfile,
  createGovernanceProfileForPlug,
  rejectGovernanceProfile,
} from '../services/governance/governanceStore.js';

const storeFile = (name) => path.join(os.tmpdir(), `acsm-ppu-generation-${name}-${process.pid}-${Date.now()}-${Math.random()}.json`);
const useStore = (name) => {
  const file = storeFile(name);
  process.env.GOVERNANCE_STORE_PATH = file;
  return file;
};
const assertContract = (event) => assert.deepEqual(validateMessage(PPU_TOPIC, event).errors, undefined);

test('successful Plug request prepares a contract-compatible PLUG:REQUESTED fact', () => {
  const file = useStore('plug-route');
  try {
    const governance = createGovernanceProfileForPlug('cpslai1', { id: 'cpslai1' }, { plugEventId: 'plug-request-001' });
    const ppuEvent = buildPlugRequestedPpuEvent({
      cpsId: 'cpslai1',
      plugEventId: 'plug-request-001',
      plugCycleId: governance.profile.plugCycleId,
      occurredAt: governance.profile.plugStartedAt,
      previousState: 'registered',
      profile: governance.profile,
      aasId: 'urn:test:cpslai1:aas',
    });
    assert.equal(ppuEvent.operation, 'PLUG');
    assert.equal(ppuEvent.result, 'REQUESTED');
    assert.equal(ppuEvent.newState, null, 'a request must not claim a resulting state');
    assert.equal(ppuEvent.correlationId, governance.profile.plugCycleId);
    assert.equal(ppuEvent.evidence.plugEventId, 'plug-request-001');
    assert.equal(validateMessage(PPU_TOPIC, ppuEvent).ok, true);
  } finally { fs.rmSync(file, { force: true }); }
});

test('effective approval prepares a correlated explicit human decision, not a Play request', () => {
  const file = useStore('approval');
  try {
    const plug = createGovernanceProfileForPlug('cpslai1', { id: 'cpslai1' }, { plugEventId: 'plug-approval-001' });
    const approved = approveGovernanceProfile('cpslai1', 'operator-a');
    assert.equal(approved.ppuEvent.operation, 'GOVERNANCE_APPROVAL');
    assert.equal(approved.ppuEvent.result, 'GOVERNANCE_DECIDED');
    assert.equal(approved.ppuEvent.correlationId, plug.profile.plugCycleId);
    assert.deepEqual(approved.ppuEvent.humanDecision, {
      decision: 'APPROVED', decidedBy: 'operator-a', decidedAt: approved.ppuEvent.occurredAt,
    });
    assert.equal(approved.ppuEvent.newState, null);
    assert.equal(validateMessage(PPU_TOPIC, approved.ppuEvent).ok, true);
    const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(persisted.profiles.cpslai1.status, 'APPROVED');
    assert.equal(persisted.ppuOutbox[approved.ppuEvent.eventId].status, 'PENDING');
    assert.deepEqual(persisted.ppuOutbox[approved.ppuEvent.eventId].payload, approved.ppuEvent);
  } finally { fs.rmSync(file, { force: true }); }
});

test('effective rejection is explicit and a repeated non-effective rejection prepares no second event', () => {
  const file = useStore('rejection');
  try {
    const plug = createGovernanceProfileForPlug('cpslai1', { id: 'cpslai1' }, { plugEventId: 'plug-rejection-001' });
    const rejected = rejectGovernanceProfile('cpslai1', 'operator-b');
    assert.equal(rejected.ppuEvent.operation, 'GOVERNANCE_REJECTION');
    assert.equal(rejected.ppuEvent.result, 'GOVERNANCE_DECIDED');
    assert.equal(rejected.ppuEvent.correlationId, plug.profile.plugCycleId);
    assert.equal(rejected.ppuEvent.humanDecision.decision, 'REJECTED');
    assert.equal(validateMessage(PPU_TOPIC, rejected.ppuEvent).ok, true);
    assert.equal(rejectGovernanceProfile('cpslai1', 'operator-b').ppuEvent, null);
    const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(persisted.profiles.cpslai1.status, 'DENIED');
    assert.equal(Object.keys(persisted.ppuOutbox).length, 1);
    assert.equal(persisted.ppuOutbox[rejected.ppuEvent.eventId].status, 'PENDING');
  } finally { fs.rmSync(file, { force: true }); }
});

test('identifiers are deterministic, correlation may be absent, and invalid requests are rejected', () => {
  const input = {
    cpsId: 'cpslai1', plugEventId: 'external id with spaces', occurredAt: '2026-01-15T12:00:00.000Z',
  };
  const first = buildPlugRequestedPpuEvent(input);
  const retry = buildPlugRequestedPpuEvent(input);
  assert.equal(first.eventId, retry.eventId);
  assert.equal(first.correlationId, null);
  assertContract(first);
  assert.throws(() => buildPlugRequestedPpuEvent({ ...input, plugEventId: '' }), /plugEventId is required/);
  assert.throws(() => buildPpuEvent({ cpsId: 'cpslai2' }), /restricted to cpslai1/);
  assert.throws(() => buildGovernanceDecisionPpuEvent({ cpsId: 'cpslai1', decision: 'MAYBE' }), /APPROVED or REJECTED/);
});

test('preparation layer contains no MQTT transport and current integrations do not publish PPU events', () => {
  const builder = fs.readFileSync(path.join(process.cwd(), 'lib/acsm/ppuEventBuilder.mjs'), 'utf8');
  const plugRoute = fs.readFileSync(path.join(process.cwd(), 'app/api/acsm/plug/route.js'), 'utf8');
  const plugHandler = fs.readFileSync(path.join(process.cwd(), 'lib/acsm/plugPostHandler.mjs'), 'utf8');
  const governance = fs.readFileSync(path.join(process.cwd(), 'services/governance/governanceStore.js'), 'utf8');
  assert.doesNotMatch(builder, /mqtt|\.publish\s*\(/i);
  assert.doesNotMatch(plugRoute, /cpslai1\/ppu\/events|\.publish\s*\(/i);
  assert.doesNotMatch(governance, /cpslai1\/ppu\/events|\.publish\s*\(/i);
  assert.ok(
    plugHandler.indexOf('if (!transition.ok)') < plugHandler.indexOf('buildPlugRequestedPpuEvent({'),
    'the route prepares the event only after the Plug transition succeeds',
  );
});
