import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { GOVERNANCE_REPOSITORY_SCHEMA_VERSION, validateGovernanceDocument } from './governanceRepository.mjs';

function migrationError(code, message, details = {}, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  error.details = details;
  return error;
}

const clone = (value) => structuredClone(value);
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => String(value || '').trim();
const BLOCKING_PROFILE_STATES = new Set(['ACTIVE', 'RESERVED', 'FAILED']);
const APPROVAL_STATES = new Set(['PENDING_APPROVAL', 'APPROVED', 'DENIED']);

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  return value;
}

function identityHash(identity) {
  return hash(JSON.stringify(stableValue(identity)));
}

function readLegacyStrict(sourcePath, readFileSync) {
  if (!sourcePath || !path.isAbsolute(sourcePath)) {
    throw migrationError('GOVERNANCE_MIGRATION_ABSOLUTE_SOURCE_REQUIRED', 'sourcePath must be absolute.');
  }
  let sourceText;
  try { sourceText = readFileSync(sourcePath, 'utf8'); }
  catch (error) { throw migrationError('GOVERNANCE_MIGRATION_READ_FAILED', 'Legacy source could not be read.', {}, error); }
  let document;
  try { document = JSON.parse(sourceText); }
  catch (error) { throw migrationError('GOVERNANCE_MIGRATION_JSON_INVALID', 'Legacy source contains invalid or truncated JSON.', {}, error); }
  validateGovernanceDocument(document);
  return { sourceText, document };
}

function validateHistoricalProfiles(document) {
  const warnings = [];
  const activeByCps = new Map();
  for (const [cpsId, versions] of Object.entries(document.profileVersions)) {
    const versionsSeen = new Map();
    const idsSeen = new Set();
    for (const [index, profile] of versions.entries()) {
      const version = Number(profile.profileVersion);
      if (Number.isFinite(version)) {
        if (versionsSeen.has(version)) {
          throw migrationError('GOVERNANCE_MIGRATION_VERSION_CONFLICT', 'Duplicate profile version for CPS.', { cpsId, version, indexes: [versionsSeen.get(version), index] });
        }
        versionsSeen.set(version, index);
      }
      if (text(profile.profileId)) {
        if (idsSeen.has(profile.profileId)) throw migrationError('GOVERNANCE_MIGRATION_PROFILE_ID_CONFLICT', 'Duplicate profileId for CPS.', { cpsId, profileId: profile.profileId });
        idsSeen.add(profile.profileId);
      } else {
        warnings.push({ code: 'LEGACY_PROFILE_WITHOUT_ID_PRESERVED', cpsId, index });
      }
      if (BLOCKING_PROFILE_STATES.has(text(profile.plugCycleStatus).toUpperCase())) {
        const list = activeByCps.get(cpsId) || [];
        list.push({ profile, index });
        activeByCps.set(cpsId, list);
      }
    }
  }
  for (const [cpsId, current] of Object.entries(document.profiles)) {
    const versions = document.profileVersions[cpsId] || [];
    if (text(current.profileId) && !versions.some((item) => item.profileId === current.profileId)) {
      throw migrationError('GOVERNANCE_MIGRATION_CURRENT_PROFILE_MISSING', 'Current profile is absent from profileVersions.', { cpsId, profileId: current.profileId });
    }
  }
  for (const [cpsId, active] of activeByCps) {
    if (active.length > 1) throw migrationError('GOVERNANCE_MIGRATION_MULTIPLE_ACTIVE_CYCLES', 'Multiple blocking profiles exist for one CPS.', { cpsId, count: active.length });
  }
  return { warnings, activeByCps };
}

function requireCycleEvidence(cpsId, profile, evidence) {
  if (!isRecord(evidence)) throw migrationError('GOVERNANCE_MIGRATION_ACTIVE_IDENTITY_INCOMPLETE', 'Active cycle requires authoritative migration evidence.', { cpsId });
  const required = ['cpsId', 'plugEventId', 'plugCycleId', 'profileId'];
  for (const field of required) {
    if (!text(evidence[field])) throw migrationError('GOVERNANCE_MIGRATION_ACTIVE_IDENTITY_INCOMPLETE', `Active cycle evidence requires ${field}.`, { cpsId, field });
  }
  if (evidence.cpsId !== cpsId || evidence.profileId !== profile.profileId ||
      (text(profile.plugEventId) && profile.plugEventId !== evidence.plugEventId) ||
      (text(profile.plugCycleId) && profile.plugCycleId !== evidence.plugCycleId)) {
    throw migrationError('GOVERNANCE_MIGRATION_ACTIVE_IDENTITY_CONFLICT', 'Migration evidence conflicts with the active profile.', { cpsId });
  }
  if (!isRecord(evidence.identity) || !text(evidence.identity.aasId) ||
      (!text(evidence.identity.assetId) && !text(evidence.identity.functionalId))) {
    throw migrationError('GOVERNANCE_MIGRATION_ACTIVE_IDENTITY_INCOMPLETE', 'Identity requires aasId and assetId or functionalId.', { cpsId });
  }
  const state = text(evidence.state || profile.plugCycleStatus).toUpperCase();
  if (!['RESERVED', 'ACTIVE', 'FAILED'].includes(state)) {
    throw migrationError('GOVERNANCE_MIGRATION_CYCLE_STATE_INVALID', 'Migrated active cycle state is invalid.', { cpsId, state });
  }
  if (!APPROVAL_STATES.has(text(profile.status).toUpperCase())) {
    throw migrationError('GOVERNANCE_MIGRATION_APPROVAL_STATE_INVALID', 'Active profile has an invalid approval state.', { cpsId, status: profile.status });
  }
  const lifecycleEvidence = evidence.lifecycleEvidence ?? null;
  if (state === 'ACTIVE' && (!isRecord(lifecycleEvidence) || lifecycleEvidence.accepted !== true || !text(lifecycleEvidence.transitionId))) {
    throw migrationError('GOVERNANCE_MIGRATION_LIFECYCLE_EVIDENCE_REQUIRED', 'ACTIVE migration requires accepted lifecycle evidence.', { cpsId });
  }
  return { state, lifecycleEvidence };
}

export class GovernanceMigrationPlanner {
  constructor({ readFileSync = fs.readFileSync } = {}) {
    this.readFileSync = readFileSync;
  }

  prevalidate({ sourcePath, activeCycleEvidence = {} } = {}) {
    const { sourceText, document } = readLegacyStrict(sourcePath, this.readFileSync);
    const { warnings, activeByCps } = validateHistoricalProfiles(document);
    const existingCycles = document.plugCycles || {};
    const cycles = clone(existingCycles);
    const createdCycles = [];
    const activeProfiles = [];

    for (const [cpsId, entries] of activeByCps) {
      const profile = entries[0].profile;
      activeProfiles.push({ cpsId, profileId: profile.profileId || null, plugCycleId: profile.plugCycleId || null, status: profile.status });
      if (!text(profile.profileId)) throw migrationError('GOVERNANCE_MIGRATION_ACTIVE_IDENTITY_INCOMPLETE', 'Active profile without profileId cannot be migrated safely.', { cpsId });
      const already = Object.values(cycles).find((cycle) => cycle?.cpsId === cpsId && cycle?.state !== 'CLOSED');
      if (already) {
        if (already.governanceProfileId !== profile.profileId || already.plugCycleId !== profile.plugCycleId) {
          throw migrationError('GOVERNANCE_MIGRATION_ACTIVE_IDENTITY_CONFLICT', 'Existing plugCycle conflicts with active profile.', { cpsId });
        }
        continue;
      }
      const evidence = activeCycleEvidence[cpsId];
      const { state, lifecycleEvidence } = requireCycleEvidence(cpsId, profile, evidence);
      if (cycles[evidence.plugCycleId]) throw migrationError('GOVERNANCE_MIGRATION_CYCLE_ID_CONFLICT', 'plugCycleId already exists.', { plugCycleId: evidence.plugCycleId });
      if (Object.values(cycles).some((cycle) => cycle.plugEventId === evidence.plugEventId)) {
        throw migrationError('GOVERNANCE_MIGRATION_EVENT_ID_CONFLICT', 'plugEventId already exists.', { plugEventId: evidence.plugEventId });
      }
      const startedAt = profile.plugStartedAt || evidence.reservedAt || null;
      const cycle = {
        plugCycleId: evidence.plugCycleId,
        plugEventId: evidence.plugEventId,
        cpsId,
        identity: clone(evidence.identity),
        identityHash: identityHash(evidence.identity),
        state,
        governanceProfileId: profile.profileId,
        governanceProfileVersion: profile.profileVersion ?? null,
        reservedAt: evidence.reservedAt || startedAt,
        activatedAt: state === 'ACTIVE' ? (evidence.activatedAt || startedAt) : null,
        failedAt: state === 'FAILED' ? (evidence.failedAt || null) : null,
        failure: state === 'FAILED' ? clone(evidence.failure || { code: 'MIGRATED_FAILED_STATE', message: 'Preserved failed state requires reconciliation.' }) : null,
        closedAt: null,
        activationEvidence: lifecycleEvidence ? clone(lifecycleEvidence) : null,
        closeEvidence: null,
        checkpoints: {
          profilePersisted: true,
          lifecycleTransitioned: Boolean(lifecycleEvidence?.accepted),
          ppuOutboxStored: Boolean(evidence.ppuOutboxStored),
          closeRequested: false,
        },
      };
      cycles[cycle.plugCycleId] = cycle;
      createdCycles.push(cycle.plugCycleId);
    }

    const candidate = clone(document);
    candidate.repositorySchemaVersion ??= GOVERNANCE_REPOSITORY_SCHEMA_VERSION;
    candidate.revision ??= 0;
    candidate.plugCycles = cycles;
    validateGovernanceDocument(candidate);
    return {
      sourceHash: hash(sourceText),
      sourceBytes: Buffer.byteLength(sourceText),
      candidate,
      report: {
        valid: true,
        sourcePath,
        sourceHash: hash(sourceText),
        profiles: Object.keys(document.profiles).length,
        profileVersions: Object.values(document.profileVersions).reduce((sum, items) => sum + items.length, 0),
        historyEntries: document.history.length,
        pendingActions: Object.keys(document.pendingActions).length,
        outboxEntries: Object.keys(document.ppuOutbox).length,
        activeProfiles,
        existingCycles: Object.keys(existingCycles).length,
        createdCycles,
        warnings,
      },
    };
  }
}
