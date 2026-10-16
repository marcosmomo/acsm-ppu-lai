import fs from 'node:fs';
import path from 'node:path';
import { deterministicHash, stableStringify } from './functionalNormalizer.mjs';
import { compareFunctionalSnapshots } from './functionalComparator.mjs';

export const EVOLUTION_STORE_SCHEMA_VERSION = '1.0';
export const EVOLUTION_PROCESSING_STATES = Object.freeze({
  PENDING: 'PENDING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
});

const STORE_QUEUES = Symbol.for('acsm.evolution.store-queues');
globalThis[STORE_QUEUES] ||= new Map();

const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
const iso = (value = new Date()) => (value instanceof Date ? value : new Date(value)).toISOString();
const normalizeCpsId = (value) => String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '')
  .replace(/^cpslai0+([123])$/, 'cpslai$1');
const supportedCps = new Set(['cpslai1', 'cpslai2', 'cpslai3']);

function storeError(code, message, details = undefined) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function emptyStore(now) {
  const timestamp = iso(now);
  return {
    schemaVersion: EVOLUTION_STORE_SCHEMA_VERSION,
    revision: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    snapshots: {},
    comparisons: {},
    identityIndex: {},
    acceptedBaselines: {},
    processing: {},
    observerFailures: {},
  };
}

function validateStore(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw storeError('EVOLUTION_STORE_CORRUPT', 'Evolution Store root must be an object.');
  }
  if (document.schemaVersion !== EVOLUTION_STORE_SCHEMA_VERSION) {
    throw storeError('EVOLUTION_STORE_VERSION_UNSUPPORTED', 'Evolution Store schema version is not supported.', {
      expected: EVOLUTION_STORE_SCHEMA_VERSION,
      actual: document.schemaVersion ?? null,
    });
  }
  // Backward-compatible additive field for failures that occur before an AAS snapshot exists.
  if (document.observerFailures == null) document.observerFailures = {};
  for (const field of ['snapshots', 'comparisons', 'identityIndex', 'acceptedBaselines', 'processing', 'observerFailures']) {
    if (!document[field] || typeof document[field] !== 'object' || Array.isArray(document[field])) {
      throw storeError('EVOLUTION_STORE_CORRUPT', `Evolution Store field ${field} must be an object.`);
    }
  }
  if (!Number.isSafeInteger(document.revision) || document.revision < 0) {
    throw storeError('EVOLUTION_STORE_CORRUPT', 'Evolution Store revision is invalid.');
  }
  return document;
}

function validateIdentity({ cpsId, plugEventId, snapshot }) {
  const normalizedCpsId = normalizeCpsId(cpsId);
  if (!supportedCps.has(normalizedCpsId)) {
    throw storeError('EVOLUTION_CPS_UNSUPPORTED', 'Evolution Store accepts only CPS-LAI-01, CPS-LAI-02 and CPS-LAI-03.');
  }
  if (!String(plugEventId || '').trim()) throw storeError('EVOLUTION_PLUG_EVENT_REQUIRED', 'plugEventId is required.');
  if (!snapshot || typeof snapshot !== 'object') throw storeError('EVOLUTION_SNAPSHOT_REQUIRED', 'A normalized functional snapshot is required.');
  if (!String(snapshot.extractionVersion || '').trim() || !String(snapshot.normalizationVersion || '').trim()) {
    throw storeError('EVOLUTION_ALGORITHM_VERSION_REQUIRED', 'Extractor and normalizer versions are required.');
  }
  if (!String(snapshot.functionalHash || '').trim() || !Array.isArray(snapshot.declarations)) {
    throw storeError('EVOLUTION_SNAPSHOT_INVALID', 'Snapshot hash and declarations are required.');
  }
  return normalizedCpsId;
}

function identityParts({ cpsId, plugEventId, snapshot }) {
  return {
    cpsId,
    plugEventId: String(plugEventId).trim(),
    extractionVersion: snapshot.extractionVersion,
    normalizationVersion: snapshot.normalizationVersion,
  };
}

function identityKey(parts) {
  return stableStringify(parts);
}

function safeError(error) {
  return {
    code: String(error?.code || 'EVOLUTION_PROCESSING_ERROR').replace(/[^A-Z0-9_-]/gi, '').slice(0, 64),
    message: String(error?.message || error || 'Unknown Evolution processing error').slice(0, 500),
  };
}

function compatibleAlgorithms(previous, current) {
  return previous.extractionVersion === current.extractionVersion &&
    previous.normalizationVersion === current.normalizationVersion;
}

function withPathQueue(filePath, task) {
  const queues = globalThis[STORE_QUEUES];
  const previous = queues.get(filePath) || Promise.resolve();
  const result = previous.then(task, task);
  let barrier;
  const cleanup = () => {
    if (queues.get(filePath) === barrier) queues.delete(filePath);
  };
  barrier = result.then(cleanup, cleanup);
  queues.set(filePath, barrier);
  return result;
}

export class EvolutionStore {
  constructor({ filePath, fileSystem = fs, now = () => new Date(), beforeRename = null } = {}) {
    if (!filePath || !path.isAbsolute(filePath)) {
      throw storeError('EVOLUTION_STORE_PATH_REQUIRED', 'An absolute Evolution Store filePath is required.');
    }
    this.filePath = path.resolve(filePath);
    this.fs = fileSystem;
    this.now = now;
    this.beforeRename = beforeRename;
  }

  _read() {
    if (!this.fs.existsSync(this.filePath)) return emptyStore(this.now());
    try {
      return validateStore(JSON.parse(this.fs.readFileSync(this.filePath, 'utf8')));
    } catch (error) {
      if (error?.code?.startsWith?.('EVOLUTION_')) throw error;
      throw storeError('EVOLUTION_STORE_CORRUPT', 'Evolution Store cannot be parsed; the file was preserved.', {
        cause: error?.message || String(error),
      });
    }
  }

  _write(document) {
    const next = validateStore(clone(document));
    next.revision += 1;
    next.updatedAt = iso(this.now());
    this.fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    try {
      const descriptor = this.fs.openSync(temporary, 'wx');
      try {
        this.fs.writeFileSync(descriptor, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
        this.fs.fsyncSync(descriptor);
      } finally {
        this.fs.closeSync(descriptor);
      }
      if (this.beforeRename) this.beforeRename({ temporary, destination: this.filePath, document: clone(next) });
      this.fs.renameSync(temporary, this.filePath);
    } catch (error) {
      try {
        if (this.fs.existsSync(temporary)) this.fs.unlinkSync(temporary);
      } catch {
        // Cleanup is best effort. The previously committed file is never deleted here.
      }
      throw error;
    }
    return next;
  }

  async inspect() {
    return withPathQueue(this.filePath, () => clone(this._read()));
  }

  async recordPending({ cpsId, plugEventId, snapshot, plugCycleId = null, at = this.now() }) {
    const normalizedCpsId = validateIdentity({ cpsId, plugEventId, snapshot });
    const parts = identityParts({ cpsId: normalizedCpsId, plugEventId, snapshot });
    const key = identityKey(parts);
    return withPathQueue(this.filePath, () => {
      const store = this._read();
      const existing = store.processing[key];
      if (existing?.state === EVOLUTION_PROCESSING_STATES.COMPLETED) return clone(existing);
      store.processing[key] = {
        ...parts,
        plugCycleId: plugCycleId || existing?.plugCycleId || null,
        state: EVOLUTION_PROCESSING_STATES.PENDING,
        updatedAt: iso(at),
        lastError: null,
        snapshotId: existing?.snapshotId || null,
        comparisonId: existing?.comparisonId || null,
      };
      return clone(this._write(store).processing[key]);
    });
  }

  async recordFailure({ cpsId, plugEventId, snapshot, plugCycleId = null, error, at = this.now() }) {
    const normalizedCpsId = validateIdentity({ cpsId, plugEventId, snapshot });
    const parts = identityParts({ cpsId: normalizedCpsId, plugEventId, snapshot });
    const key = identityKey(parts);
    return withPathQueue(this.filePath, () => {
      const store = this._read();
      const existing = store.processing[key];
      if (existing?.state === EVOLUTION_PROCESSING_STATES.COMPLETED) {
        throw storeError('EVOLUTION_PROCESSING_ALREADY_COMPLETED', 'Completed processing cannot be marked as failed.');
      }
      store.processing[key] = {
        ...parts,
        plugCycleId: plugCycleId || existing?.plugCycleId || null,
        state: EVOLUTION_PROCESSING_STATES.FAILED,
        updatedAt: iso(at),
        lastError: safeError(error),
        snapshotId: existing?.snapshotId || null,
        comparisonId: existing?.comparisonId || null,
      };
      return clone(this._write(store).processing[key]);
    });
  }

  async recordCapture({
    cpsId, plugEventId, plugCycleId = null, snapshot,
    capturedAt = this.now(), provenance = {}, pending = [], aasReference = null,
  }) {
    const normalizedCpsId = validateIdentity({ cpsId, plugEventId, snapshot });
    const parts = identityParts({ cpsId: normalizedCpsId, plugEventId, snapshot });
    const key = identityKey(parts);
    const payload = {
      ...parts,
      plugCycleId: plugCycleId || null,
      capturedAt: iso(capturedAt),
      snapshot,
      provenance,
      pending,
      aasReference,
    };
    // Capture time is observational metadata. A retry of the same accepted Plug may
    // occur later and must resolve to the first immutable record, not conflict.
    const payloadHash = deterministicHash({
      ...payload,
      capturedAt: undefined,
      // Resolution time is useful provenance but must not make a retry of the same
      // immutable AAS/event identity conflict with the first committed capture.
      aasReference: aasReference ? { ...aasReference, resolvedAt: undefined } : null,
    });
    const snapshotId = `evo_snap_${deterministicHash(parts).slice(0, 32)}`;
    const comparisonId = `evo_cmp_${deterministicHash({ ...parts, type: 'comparison' }).slice(0, 32)}`;

    return withPathQueue(this.filePath, () => {
      const store = this._read();
      const indexed = store.identityIndex[key];
      if (indexed) {
        if (indexed.payloadHash !== payloadHash) {
          throw storeError('EVOLUTION_IDENTITY_CONFLICT', 'The stable Evolution identity already exists with a different payload.', {
            snapshotId: indexed.snapshotId,
          });
        }
        return {
          duplicate: true,
          promoted: Boolean(store.comparisons[indexed.comparisonId]?.promoted),
          snapshot: clone(store.snapshots[indexed.snapshotId]),
          comparison: clone(store.comparisons[indexed.comparisonId]),
          processing: clone(store.processing[key]),
        };
      }

      const baselinePointer = store.acceptedBaselines[normalizedCpsId] || null;
      const previousSnapshot = baselinePointer ? store.snapshots[baselinePointer.snapshotId]?.snapshot : null;
      let comparison;
      if (previousSnapshot && !compatibleAlgorithms(previousSnapshot, snapshot)) {
        comparison = {
          comparisonVersion: null,
          status: 'INDETERMINATE',
          reason: 'ALGORITHM_VERSION_INCOMPATIBLE',
          previous: {
            snapshotId: baselinePointer.snapshotId,
            extractionVersion: previousSnapshot.extractionVersion,
            normalizationVersion: previousSnapshot.normalizationVersion,
          },
          current: {
            snapshotId,
            extractionVersion: snapshot.extractionVersion,
            normalizationVersion: snapshot.normalizationVersion,
          },
          differences: [],
          ambiguities: [],
        };
      } else {
        comparison = compareFunctionalSnapshots(previousSnapshot, snapshot);
      }

      const promoted = ['BASELINE', 'NO_CHANGE', 'CHANGED'].includes(comparison.status) && snapshot.completeness !== 'INCOMPLETE';
      const previousFunctionalVersion = Number(baselinePointer?.functionalVersion || 0);
      const functionalVersion = comparison.status === 'CHANGED'
        ? previousFunctionalVersion + 1
        : previousFunctionalVersion || 1;
      const snapshotRecord = {
        snapshotId,
        cpsId: normalizedCpsId,
        plugEventId: parts.plugEventId,
        plugCycleId: plugCycleId || null,
        aas: clone(snapshot.source || {}),
        extractionVersion: snapshot.extractionVersion,
        normalizationVersion: snapshot.normalizationVersion,
        capturedAt: payload.capturedAt,
        completeness: snapshot.completeness,
        functionalHash: snapshot.functionalHash,
        functionalVersion: promoted ? functionalVersion : null,
        declarations: clone(snapshot.declarations),
        provenance: clone(provenance),
        aasReference: clone(aasReference),
        pending: clone(pending),
        issues: clone(snapshot.issues || []),
        previousSnapshotId: baselinePointer?.snapshotId || null,
        snapshot: clone(snapshot),
      };
      const comparisonRecord = {
        comparisonId,
        cpsId: normalizedCpsId,
        plugEventId: parts.plugEventId,
        plugCycleId: plugCycleId || null,
        previousSnapshotId: baselinePointer?.snapshotId || null,
        currentSnapshotId: snapshotId,
        aasReference: clone(aasReference),
        comparedAt: payload.capturedAt,
        status: comparison.status,
        reason: comparison.reason || null,
        promoted,
        differences: clone(comparison.differences || []),
        ambiguities: clone(comparison.ambiguities || []),
        result: clone(comparison),
      };

      store.snapshots[snapshotId] = snapshotRecord;
      store.comparisons[comparisonId] = comparisonRecord;
      store.identityIndex[key] = { ...parts, payloadHash, snapshotId, comparisonId };
      store.processing[key] = {
        ...parts,
        plugCycleId: plugCycleId || null,
        state: EVOLUTION_PROCESSING_STATES.COMPLETED,
        updatedAt: payload.capturedAt,
        lastError: null,
        snapshotId,
        comparisonId,
      };
      if (promoted) {
        store.acceptedBaselines[normalizedCpsId] = {
          cpsId: normalizedCpsId,
          snapshotId,
          comparisonId,
          functionalVersion,
          acceptedAt: payload.capturedAt,
        };
      }
      this._write(store);
      return {
        duplicate: false,
        promoted,
        snapshot: clone(snapshotRecord),
        comparison: clone(comparisonRecord),
        processing: clone(store.processing[key]),
      };
    });
  }

  async getAcceptedBaseline(cpsId) {
    const key = normalizeCpsId(cpsId);
    return withPathQueue(this.filePath, () => {
      const store = this._read();
      const pointer = store.acceptedBaselines[key];
      return pointer ? { pointer: clone(pointer), snapshot: clone(store.snapshots[pointer.snapshotId]) } : null;
    });
  }

  async listComparisons({ cpsId = null } = {}) {
    const key = cpsId ? normalizeCpsId(cpsId) : null;
    return withPathQueue(this.filePath, () => Object.values(this._read().comparisons)
      .filter((item) => !key || item.cpsId === key)
      .sort((a, b) => a.comparedAt.localeCompare(b.comparedAt) || a.comparisonId.localeCompare(b.comparisonId))
      .map(clone));
  }

  async listProcessing({ states = [EVOLUTION_PROCESSING_STATES.PENDING, EVOLUTION_PROCESSING_STATES.FAILED] } = {}) {
    const accepted = new Set(states);
    return withPathQueue(this.filePath, () => Object.values(this._read().processing)
      .filter((item) => accepted.has(item.state))
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
      .map(clone));
  }

  async recordObserverFailure({ cpsId, plugEventId, plugCycleId = null, stage = 'OBSERVATION', error, at = this.now() } = {}) {
    const normalizedCpsId = normalizeCpsId(cpsId);
    if (!supportedCps.has(normalizedCpsId)) throw storeError('EVOLUTION_CPS_UNSUPPORTED', 'Evolution Store accepts only CPS-LAI-01/02/03.');
    const eventId = String(plugEventId || '').trim();
    if (!eventId) throw storeError('EVOLUTION_PLUG_EVENT_REQUIRED', 'plugEventId is required to record an observer failure.');
    const normalizedStage = String(stage || 'OBSERVATION').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 64);
    const failureId = `evo_fail_${deterministicHash({ cpsId: normalizedCpsId, plugEventId: eventId, stage: normalizedStage }).slice(0, 32)}`;
    return withPathQueue(this.filePath, () => {
      const store = this._read();
      const existing = store.observerFailures[failureId];
      const failure = {
        failureId,
        cpsId: normalizedCpsId,
        plugEventId: eventId,
        plugCycleId: plugCycleId || existing?.plugCycleId || null,
        stage: normalizedStage,
        state: 'FAILED',
        attempts: (existing?.attempts || 0) + 1,
        firstFailedAt: existing?.firstFailedAt || iso(at),
        lastFailedAt: iso(at),
        lastError: safeError(error),
      };
      store.observerFailures[failureId] = failure;
      this._write(store);
      return clone(failure);
    });
  }

  async listObserverFailures({ cpsId = null } = {}) {
    const key = cpsId ? normalizeCpsId(cpsId) : null;
    return withPathQueue(this.filePath, () => Object.values(this._read().observerFailures)
      .filter((item) => !key || item.cpsId === key)
      .sort((a, b) => a.firstFailedAt.localeCompare(b.firstFailedAt))
      .map(clone));
  }
}
