import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const GOVERNANCE_REPOSITORY_SCHEMA_VERSION = 1;
export const GOVERNANCE_CYCLE_STATES = Object.freeze(['RESERVED', 'ACTIVE', 'FAILED', 'CLOSED']);
export const GOVERNANCE_PROFILE_STATES = Object.freeze(['PENDING_APPROVAL', 'APPROVED', 'DENIED']);

const NO_OP_MARKER = Symbol('governance.repository.no-op');

/** Return from a mutator after an in-lock verification to skip validation and persistence. */
export function governanceTransactionNoOp(value) {
  return Object.freeze({ [NO_OP_MARKER]: true, value });
}

const CYCLE_STATES = new Set(GOVERNANCE_CYCLE_STATES);

function repositoryError(code, message, details = {}, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  error.details = details;
  return error;
}

function clone(value) {
  return structuredClone(value);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function stableHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

function assertCycleIdentitiesImmutable(currentCycles = {}, nextCycles = {}) {
  for (const [cycleId, current] of Object.entries(currentCycles)) {
    if (!current?.identityHash) continue;
    const next = nextCycles[cycleId];
    if (!next || !isRecord(next.identity) || next.identityHash !== current.identityHash || stableHash(next.identity) !== current.identityHash ||
        stableHash(next.aasReference ?? null) !== stableHash(current.aasReference ?? null)) {
      throw repositoryError('GOVERNANCE_CYCLE_IDENTITY_IMMUTABLE', 'A reserved cycle identity and AAS reference cannot be replaced or removed.', {
        plugCycleId: cycleId,
      });
    }
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireRecord(value, field) {
  if (!isRecord(value)) {
    throw repositoryError('GOVERNANCE_SCHEMA_INVALID', `${field} must be an object.`, { field });
  }
}

function requireRecordValues(value, field) {
  requireRecord(value, field);
  for (const [key, entry] of Object.entries(value)) {
    if (!isRecord(entry)) {
      throw repositoryError('GOVERNANCE_SCHEMA_INVALID', `${field}.${key} must be an object.`, { field: `${field}.${key}` });
    }
  }
}

/** Strict structural validation only. It never fills or rewrites legacy data. */
export function validateGovernanceDocument(document) {
  requireRecord(document, '$');
  requireRecordValues(document.profiles, 'profiles');
  requireRecord(document.profileVersions, 'profileVersions');
  for (const [cpsId, versions] of Object.entries(document.profileVersions)) {
    if (!Array.isArray(versions) || versions.some((profile) => !isRecord(profile))) {
      throw repositoryError('GOVERNANCE_SCHEMA_INVALID', `profileVersions.${cpsId} must be an array of objects.`, { field: `profileVersions.${cpsId}` });
    }
  }
  requireRecordValues(document.pendingActions, 'pendingActions');
  if (!Array.isArray(document.history) || document.history.some((entry) => !isRecord(entry))) {
    throw repositoryError('GOVERNANCE_SCHEMA_INVALID', 'history must be an array of objects.', { field: 'history' });
  }
  requireRecordValues(document.ppuOutbox, 'ppuOutbox');

  if (document.revision !== undefined && (!Number.isSafeInteger(document.revision) || document.revision < 0)) {
    throw repositoryError('GOVERNANCE_SCHEMA_INVALID', 'revision must be a non-negative safe integer.', { field: 'revision' });
  }
  if (document.repositorySchemaVersion !== undefined && document.repositorySchemaVersion !== GOVERNANCE_REPOSITORY_SCHEMA_VERSION) {
    throw repositoryError('GOVERNANCE_SCHEMA_UNSUPPORTED', 'Unsupported governance repository schema version.', {
      repositorySchemaVersion: document.repositorySchemaVersion,
    });
  }

  if (document.plugCycles !== undefined) {
    requireRecordValues(document.plugCycles, 'plugCycles');
    const blockingByCps = new Map();
    const events = new Map();
    const lifecycleTransitions = new Map();
    for (const [key, cycle] of Object.entries(document.plugCycles)) {
      if (!String(cycle.plugCycleId || '').trim() || cycle.plugCycleId !== key) {
        throw repositoryError('GOVERNANCE_SCHEMA_INVALID', `plugCycles.${key} has an invalid plugCycleId.`, { field: `plugCycles.${key}.plugCycleId` });
      }
      if (!String(cycle.cpsId || '').trim() || !String(cycle.plugEventId || '').trim()) {
        throw repositoryError('GOVERNANCE_SCHEMA_INVALID', `plugCycles.${key} requires cpsId and plugEventId.`, { field: `plugCycles.${key}` });
      }
      if (!CYCLE_STATES.has(cycle.state)) {
        throw repositoryError('GOVERNANCE_SCHEMA_INVALID', `plugCycles.${key} has an invalid cycle state.`, { field: `plugCycles.${key}.state`, state: cycle.state });
      }
      if (cycle.identityHash !== undefined) {
        if (!isRecord(cycle.identity) || !/^[a-f0-9]{64}$/i.test(String(cycle.identityHash)) ||
            stableHash(cycle.identity) !== String(cycle.identityHash).toLowerCase()) {
          throw repositoryError('GOVERNANCE_CYCLE_IDENTITY_HASH_INVALID', `plugCycles.${key} identity hash does not match its frozen identity.`, {
            field: `plugCycles.${key}.identityHash`,
          });
        }
      }
      if (cycle.aasReference !== undefined) {
        const reference = cycle.aasReference;
        const identity = cycle.identity;
        const requiredAasFields = ['referenceId', 'aasId', 'assetId', 'contentHash', 'sourceId', 'sourceType'];
        if (!isRecord(reference) || !cycle.identityHash ||
            reference.cpsId !== cycle.cpsId || reference.plugEventId !== cycle.plugEventId ||
            reference.plugCycleId !== cycle.plugCycleId || reference.profileId !== cycle.governanceProfileId ||
            requiredAasFields.some((field) => !String(reference[field] || '').trim()) ||
            !/^[a-f0-9]{64}$/i.test(String(reference.contentHash)) ||
            reference.referenceId !== identity.aasReferenceId || reference.aasId !== identity.aasId ||
            reference.assetId !== identity.assetId || reference.contentHash !== identity.contentHash ||
            reference.sourceId !== identity.sourceId || reference.sourceType !== identity.sourceType ||
            (reference.version ?? null) !== (identity.aasVersion ?? null) ||
            (reference.revision ?? null) !== (identity.aasRevision ?? null)) {
          throw repositoryError('GOVERNANCE_CYCLE_AAS_REFERENCE_INVALID', `plugCycles.${key} AAS reference is not correlated with its frozen identity.`, {
            field: `plugCycles.${key}.aasReference`,
          });
        }
      }
      if (cycle.checkpoints !== undefined) {
        requireRecord(cycle.checkpoints, `plugCycles.${key}.checkpoints`);
        for (const checkpoint of ['profilePersisted', 'lifecycleTransitioned', 'ppuOutboxStored', 'closeRequested']) {
          if (typeof cycle.checkpoints[checkpoint] !== 'boolean') {
            throw repositoryError('GOVERNANCE_SCHEMA_INVALID', `plugCycles.${key}.checkpoints.${checkpoint} must be boolean.`, {
              field: `plugCycles.${key}.checkpoints.${checkpoint}`,
            });
          }
        }
        for (const checkpoint of ['plugEvidenceStored', 'unplugEvidenceStored']) {
          if (cycle.checkpoints[checkpoint] !== undefined && typeof cycle.checkpoints[checkpoint] !== 'boolean') {
            throw repositoryError('GOVERNANCE_SCHEMA_INVALID', `plugCycles.${key}.checkpoints.${checkpoint} must be boolean.`, {
              field: `plugCycles.${key}.checkpoints.${checkpoint}`,
            });
          }
        }
      }
      if (cycle.lifecycleEvidence !== undefined) {
        requireRecord(cycle.lifecycleEvidence, `plugCycles.${key}.lifecycleEvidence`);
        for (const [operation, stored] of Object.entries(cycle.lifecycleEvidence)) {
          if (!['PLUG', 'UNPLUG'].includes(operation) || !isRecord(stored) || !isRecord(stored.evidence) ||
              !['VALIDATED', 'PENDING_RECONCILIATION'].includes(stored.status) ||
              !String(stored.storedAt || '').trim() || !Number.isFinite(Date.parse(stored.storedAt)) ||
              new Date(Date.parse(stored.storedAt)).toISOString() !== stored.storedAt) {
            throw repositoryError('GOVERNANCE_SCHEMA_INVALID', `plugCycles.${key}.lifecycleEvidence.${operation} is invalid.`, {
              field: `plugCycles.${key}.lifecycleEvidence.${operation}`,
            });
          }
          const evidence = stored.evidence;
          if (evidence.operation !== operation || evidence.cpsId !== cycle.cpsId ||
              evidence.plugEventId !== cycle.plugEventId || evidence.plugCycleId !== cycle.plugCycleId ||
              evidence.profileId !== cycle.governanceProfileId ||
              !String(evidence.transitionId || '').trim() || !String(evidence.evidenceId || '').trim() ||
              !/^[a-f0-9]{64}$/i.test(String(evidence.contentHash || ''))) {
            throw repositoryError('GOVERNANCE_SCHEMA_INVALID', `plugCycles.${key}.lifecycleEvidence.${operation} does not match its cycle.`, {
              field: `plugCycles.${key}.lifecycleEvidence.${operation}.evidence`,
            });
          }
          const priorTransition = lifecycleTransitions.get(evidence.transitionId);
          if (priorTransition) {
            throw repositoryError('GOVERNANCE_INVARIANT_VIOLATION', 'A lifecycle transitionId may be persisted only once.', {
              transitionId: evidence.transitionId, cycles: [priorTransition, key],
            });
          }
          lifecycleTransitions.set(evidence.transitionId, key);
          const checkpoint = operation === 'PLUG' ? 'plugEvidenceStored' : 'unplugEvidenceStored';
          if (cycle.checkpoints?.[checkpoint] !== true) {
            throw repositoryError('GOVERNANCE_INVARIANT_VIOLATION', 'Persisted lifecycle evidence must have its same-commit evidence checkpoint.', {
              cycleId: key, operation, checkpoint,
            });
          }
        }
        for (const [operation, checkpoint] of [['PLUG', 'plugEvidenceStored'], ['UNPLUG', 'unplugEvidenceStored']]) {
          if (cycle.checkpoints?.[checkpoint] === true && !cycle.lifecycleEvidence[operation]) {
            throw repositoryError('GOVERNANCE_INVARIANT_VIOLATION', 'Lifecycle evidence checkpoint has no corresponding evidence record.', {
              cycleId: key, operation, checkpoint,
            });
          }
        }
      }
      if (cycle.logicalTransitions !== undefined) {
        requireRecord(cycle.logicalTransitions, `plugCycles.${key}.logicalTransitions`);
        for (const [operation, transition] of Object.entries(cycle.logicalTransitions)) {
          const evidence = cycle.lifecycleEvidence?.[operation]?.evidence;
          if (!['PLUG', 'UNPLUG'].includes(operation) || !isRecord(transition) || !evidence ||
              transition.transitionId !== evidence.transitionId || transition.operation !== operation ||
              transition.cpsId !== cycle.cpsId || transition.plugEventId !== cycle.plugEventId ||
              transition.plugCycleId !== cycle.plugCycleId || transition.profileId !== cycle.governanceProfileId ||
              transition.previousState !== evidence.previousState || transition.resultingState !== evidence.resultingState ||
              transition.outcome !== 'ACCEPTED') {
            throw repositoryError('GOVERNANCE_INVARIANT_VIOLATION', 'Logical transition and lifecycle evidence must be correlated in the same cycle record.', {
              cycleId: key, operation,
            });
          }
        }
        const latestOperation = cycle.logicalTransitions.UNPLUG ? 'UNPLUG' : cycle.logicalTransitions.PLUG ? 'PLUG' : null;
        if (latestOperation && cycle.authoritativeLifecycleState !== cycle.logicalTransitions[latestOperation].resultingState) {
          throw repositoryError('GOVERNANCE_INVARIANT_VIOLATION', 'Authoritative logical state must match the latest persisted transition.', {
            cycleId: key, latestOperation,
          });
        }
      }
      const priorEvent = events.get(cycle.plugEventId);
      if (priorEvent && priorEvent !== key) {
        throw repositoryError('GOVERNANCE_INVARIANT_VIOLATION', 'plugEventId must be unique.', { plugEventId: cycle.plugEventId });
      }
      events.set(cycle.plugEventId, key);
      if (cycle.state !== 'CLOSED') {
        const priorCycle = blockingByCps.get(cycle.cpsId);
        if (priorCycle && priorCycle !== key) {
          throw repositoryError('GOVERNANCE_INVARIANT_VIOLATION', 'A CPS cannot have two non-closed cycles.', { cpsId: cycle.cpsId, cycles: [priorCycle, key] });
        }
        blockingByCps.set(cycle.cpsId, key);
      }
    }
  }
  return true;
}

/**
 * Isolated JSON repository. It has no default path and no operational imports.
 * Mutators must be synchronous so no external asynchronous work can run while
 * the repository lock is held.
 */
export class GovernanceRepository {
  constructor({ filePath, now = () => new Date().toISOString(), lockTimeoutMs = 5000, retryMs = 10, faultInjector = null } = {}) {
    if (!filePath || !path.isAbsolute(filePath)) {
      throw repositoryError('GOVERNANCE_PATH_ABSOLUTE_REQUIRED', 'filePath must be an explicitly supplied absolute path.');
    }
    this.filePath = path.resolve(filePath);
    this.lockPath = `${this.filePath}.lock`;
    this.now = now;
    this.lockTimeoutMs = lockTimeoutMs;
    this.retryMs = retryMs;
    this.faultInjector = faultInjector;
  }

  read() {
    const document = this.#readStrict();
    return { document: clone(document), revision: document.revision ?? 0 };
  }

  initialize(document) {
    this.#acquireLock();
    try {
      if (fs.existsSync(this.filePath)) {
        throw repositoryError('GOVERNANCE_STORE_ALREADY_EXISTS', 'Governance store already exists.');
      }
      validateGovernanceDocument(document);
      const committed = {
        ...clone(document),
        repositorySchemaVersion: document.repositorySchemaVersion ?? GOVERNANCE_REPOSITORY_SCHEMA_VERSION,
        revision: document.revision ?? 0,
        plugCycles: document.plugCycles ?? {},
      };
      validateGovernanceDocument(committed);
      this.#writeAtomic(committed);
      return { document: clone(committed), revision: committed.revision };
    } finally {
      this.#releaseLock();
    }
  }

  transact(mutator, { expectedRevision } = {}) {
    if (typeof mutator !== 'function') throw repositoryError('GOVERNANCE_MUTATOR_REQUIRED', 'A synchronous mutator function is required.');
    if (mutator.constructor?.name === 'AsyncFunction') {
      throw repositoryError('GOVERNANCE_ASYNC_MUTATOR_FORBIDDEN', 'Async mutators are rejected before lock acquisition.');
    }
    if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) {
      throw repositoryError('GOVERNANCE_REVISION_INVALID', 'expectedRevision must be a non-negative safe integer.');
    }
    this.#acquireLock();
    try {
      const current = this.#readStrict();
      const baseRevision = current.revision ?? 0;
      if (expectedRevision !== undefined && expectedRevision !== baseRevision) {
        throw repositoryError('GOVERNANCE_REVISION_CONFLICT', 'Governance revision is stale.', { expectedRevision, actualRevision: baseRevision });
      }
      const draft = clone(current);
      draft.repositorySchemaVersion ??= GOVERNANCE_REPOSITORY_SCHEMA_VERSION;
      draft.plugCycles ??= {};
      const result = mutator(draft, Object.freeze({ baseRevision }));
      if (result && typeof result.then === 'function') {
        throw repositoryError('GOVERNANCE_ASYNC_MUTATOR_FORBIDDEN', 'Mutators must be synchronous; external asynchronous work is forbidden while locked.');
      }
      if (result?.[NO_OP_MARKER] === true) {
        return { document: clone(current), revision: baseRevision, result: clone(result.value), committed: false };
      }
      assertCycleIdentitiesImmutable(current.plugCycles || {}, draft.plugCycles || {});
      draft.revision = baseRevision + 1;
      validateGovernanceDocument(draft);
      this.#writeAtomic(draft);
      return { document: clone(draft), revision: draft.revision, result: clone(result), committed: true };
    } finally {
      this.#releaseLock();
    }
  }

  inspectLock() {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.lockPath, 'owner.json'), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw repositoryError('GOVERNANCE_LOCK_INSPECTION_FAILED', 'Could not inspect governance lock.', {}, error);
    }
  }

  releaseOrphanedLock({ verified, reason } = {}) {
    if (verified !== true || !String(reason || '').trim()) {
      throw repositoryError('GOVERNANCE_LOCK_VERIFICATION_REQUIRED', 'Explicit external verification and a reason are required.');
    }
    const owner = this.inspectLock();
    if (!owner) return { released: false, owner: null };
    fs.rmSync(this.lockPath, { recursive: true, force: false });
    return { released: true, owner, reason: String(reason).trim() };
  }

  #acquireLock() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const deadline = Date.now() + this.lockTimeoutMs;
    while (true) {
      try {
        fs.mkdirSync(this.lockPath);
        const ownerFile = path.join(this.lockPath, 'owner.json');
        const descriptor = fs.openSync(ownerFile, 'wx');
        try {
          fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, acquiredAt: this.now(), store: this.filePath }), 'utf8');
          fs.fsyncSync(descriptor);
        } finally {
          fs.closeSync(descriptor);
        }
        return;
      } catch (error) {
        if (error.code !== 'EEXIST') {
          throw repositoryError('GOVERNANCE_LOCK_ACQUIRE_FAILED', 'Could not acquire governance lock; any partial lock remains fail-closed.', {}, error);
        }
        if (Date.now() >= deadline) {
          throw repositoryError('GOVERNANCE_REPOSITORY_BUSY', 'Governance store is locked and was not released automatically.', { owner: this.inspectLock() });
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, this.retryMs);
      }
    }
  }

  #releaseLock() {
    fs.rmSync(this.lockPath, { recursive: true, force: false });
  }

  #readStrict() {
    let text;
    try {
      text = fs.readFileSync(this.filePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') throw repositoryError('GOVERNANCE_STORE_NOT_FOUND', 'Governance store does not exist; initialize it explicitly.', {}, error);
      throw repositoryError('GOVERNANCE_READ_FAILED', 'Governance store could not be read.', {}, error);
    }
    let document;
    try {
      document = JSON.parse(text);
    } catch (error) {
      throw repositoryError('GOVERNANCE_JSON_INVALID', 'Governance store contains invalid or truncated JSON.', {}, error);
    }
    validateGovernanceDocument(document);
    return document;
  }

  #writeAtomic(document) {
    const temporary = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      const descriptor = fs.openSync(temporary, 'wx');
      try {
        fs.writeFileSync(descriptor, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      this.faultInjector?.('beforeRename', { temporary, filePath: this.filePath });
      fs.renameSync(temporary, this.filePath);
      this.#syncDirectoryBestEffort();
    } catch (error) {
      try { fs.unlinkSync(temporary); } catch { /* best effort for this transaction's own temporary file */ }
      if (error?.code?.startsWith?.('GOVERNANCE_')) throw error;
      throw repositoryError('GOVERNANCE_WRITE_FAILED', 'Governance commit failed.', {}, error);
    }
  }

  #syncDirectoryBestEffort() {
    let descriptor;
    try {
      descriptor = fs.openSync(path.dirname(this.filePath), 'r');
      fs.fsyncSync(descriptor);
    } catch (error) {
      if (!['EINVAL', 'EPERM', 'EACCES', 'EBADF'].includes(error.code)) throw error;
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }
}
