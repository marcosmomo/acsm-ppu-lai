import { validateMessage, PPU_TOPIC } from '../../services/cps-lai-01-persistence/src/contracts.js';
import { createHash } from 'node:crypto';

const TARGET_CPS_ID = 'cpslai1';

const normalizeCpsId = (value) =>
  String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '').replace(/(cps)0+/, '$1');

const cleanOptional = (value) => value === undefined ? null : value;
const stableToken = (value) => createHash('sha256').update(String(value)).digest('hex');

export function buildPpuEvent({
  eventId,
  correlationId = null,
  commandId = null,
  cpsId,
  operation,
  result,
  previousState = null,
  newState = null,
  occurredAt,
  actor = null,
  humanDecision = null,
  source = 'ACSM',
  evidence = {},
  episodeId = null,
} = {}) {
  const normalizedCpsId = normalizeCpsId(cpsId);
  if (normalizedCpsId !== TARGET_CPS_ID) {
    throw new Error('PPU event preparation is restricted to cpslai1.');
  }

  const envelope = {
    schemaVersion: '1.0',
    eventId,
    correlationId: cleanOptional(correlationId),
    commandId: cleanOptional(commandId),
    cpsId: normalizedCpsId,
    operation,
    result,
    previousState: cleanOptional(previousState),
    newState: cleanOptional(newState),
    occurredAt,
    actor: cleanOptional(actor),
    humanDecision: cleanOptional(humanDecision),
    source,
    evidence: cleanOptional(evidence) ?? {},
    episodeId: cleanOptional(episodeId),
  };
  const validation = validateMessage(PPU_TOPIC, envelope, TARGET_CPS_ID);
  if (!validation.ok) {
    const error = new Error(`Invalid PPU event: ${validation.errors.join(',')}`);
    error.code = 'INVALID_PPU_EVENT';
    error.details = validation.errors;
    throw error;
  }
  return Object.freeze(envelope);
}

export function buildPlugRequestedPpuEvent({ cpsId, plugEventId, plugCycleId, occurredAt, previousState = null, profile, aasId = null } = {}) {
  if (typeof plugEventId !== 'string' || !plugEventId.trim()) throw new Error('plugEventId is required.');
  return buildPpuEvent({
    eventId: `ppu:${normalizeCpsId(cpsId)}:plug:${stableToken(plugEventId)}:requested`,
    correlationId: plugCycleId || null,
    cpsId,
    operation: 'PLUG',
    result: 'REQUESTED',
    previousState,
    newState: null,
    occurredAt,
    actor: { id: 'acsm1', type: 'SYSTEM' },
    source: 'ACSM',
    evidence: {
      plugEventId,
      plugCycleId: plugCycleId || null,
      governanceProfileId: profile?.profileId || null,
      governanceProfileVersion: profile?.profileVersion ?? null,
      aasId,
    },
  });
}

export function buildGovernanceDecisionPpuEvent({ cpsId, decision, decidedBy, decisionEvent, profile } = {}) {
  const normalizedDecision = String(decision || '').trim().toUpperCase();
  if (!['APPROVED', 'REJECTED'].includes(normalizedDecision)) {
    throw new Error('Governance decision must be APPROVED or REJECTED.');
  }
  const operation = normalizedDecision === 'APPROVED'
    ? 'GOVERNANCE_APPROVAL'
    : 'GOVERNANCE_REJECTION';
  return buildPpuEvent({
    eventId: `ppu:${normalizeCpsId(cpsId)}:governance:${decisionEvent?.id}:${normalizedDecision.toLowerCase()}`,
    correlationId: profile?.plugCycleId || null,
    cpsId,
    operation,
    result: 'GOVERNANCE_DECIDED',
    occurredAt: decisionEvent?.timestamp,
    actor: { id: decidedBy, type: 'HUMAN' },
    humanDecision: {
      decision: normalizedDecision,
      decidedBy,
      decidedAt: decisionEvent?.timestamp,
    },
    source: 'ACSM_GOVERNANCE',
    evidence: {
      governanceHistoryId: decisionEvent?.id || null,
      governanceProfileId: profile?.profileId || null,
      governanceProfileVersion: profile?.profileVersion ?? null,
      plugEventId: profile?.plugEventId || null,
      plugCycleId: profile?.plugCycleId || null,
    },
  });
}
