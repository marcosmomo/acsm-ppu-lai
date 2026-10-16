import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const EXPERIMENTAL_AAS_SELECTION_SCHEMA_VERSION = '1.0';

const queues = new Map();
const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
const text = (value) => value == null ? '' : String(value).trim();
const normalizeCpsId = (value) => text(value).toLowerCase().replace(/[^a-z0-9]/g, '')
  .replace(/^cpslai0+1$/, 'cpslai1');
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function storeError(code, message, details = undefined) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function withPathQueue(filePath, task) {
  const prior = queues.get(filePath) || Promise.resolve();
  const current = prior.catch(() => {}).then(task);
  queues.set(filePath, current);
  return current.finally(() => { if (queues.get(filePath) === current) queues.delete(filePath); });
}

function emptyStore() {
  return {
    schemaVersion: EXPERIMENTAL_AAS_SELECTION_SCHEMA_VERSION,
    sourceClassification: 'EXPERIMENTAL_ONLY', selections: {}, history: [],
  };
}

function validateRequest(input) {
  const request = {
    cpsId: normalizeCpsId(input?.cpsId),
    plugEventId: text(input?.plugEventId),
    plugCycleId: text(input?.plugCycleId) || null,
    profileId: text(input?.profileId) || null,
    aasVersion: text(input?.aasVersion).toLowerCase(),
    aasSha256: text(input?.aasSha256).toLowerCase(),
  };
  if (request.cpsId !== 'cpslai1') throw storeError('EXPERIMENTAL_SELECTION_CPS_NOT_ALLOWED', 'Selection accepts only cpslai1.');
  if (!request.plugEventId) throw storeError('EXPERIMENTAL_SELECTION_PLUG_EVENT_REQUIRED', 'plugEventId is required.');
  if (!/^v[123]$/.test(request.aasVersion)) throw storeError('EXPERIMENTAL_SELECTION_VERSION_INVALID', 'aasVersion must be v1, v2 or v3.');
  if (!/^[a-f0-9]{64}$/.test(request.aasSha256)) throw storeError('EXPERIMENTAL_SELECTION_HASH_INVALID', 'aasSha256 must be a lowercase SHA-256 digest.');
  return request;
}

function stableFields(record) {
  return {
    cpsId: record.cpsId, plugEventId: record.plugEventId, aasVersion: record.aasVersion,
    aasSha256: record.aasSha256, plugCycleId: record.plugCycleId, profileId: record.profileId,
  };
}

export class ExperimentalAasSelectionStore {
  constructor({ filePath, fileSystem = fs, now = () => new Date() } = {}) {
    if (!filePath || !path.isAbsolute(filePath)) {
      throw storeError('EXPERIMENTAL_SELECTION_STORE_PATH_REQUIRED', 'An absolute experimental Store path must be injected.');
    }
    this.filePath = path.resolve(filePath);
    this.fs = fileSystem;
    this.now = now;
  }

  _read() {
    if (!this.fs.existsSync(this.filePath)) return emptyStore();
    let document;
    try { document = JSON.parse(this.fs.readFileSync(this.filePath, 'utf8')); }
    catch (error) { throw storeError('EXPERIMENTAL_SELECTION_STORE_CORRUPT', 'Experimental selection Store is not valid JSON.', { cause: error?.message }); }
    if (document?.schemaVersion !== EXPERIMENTAL_AAS_SELECTION_SCHEMA_VERSION ||
        document?.sourceClassification !== 'EXPERIMENTAL_ONLY' ||
        !document.selections || !Array.isArray(document.history)) {
      throw storeError('EXPERIMENTAL_SELECTION_STORE_CORRUPT', 'Experimental selection Store schema is invalid.');
    }
    return document;
  }

  _write(document) {
    this.fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      this.fs.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { flag: 'wx' });
      this.fs.renameSync(temporary, this.filePath);
    } finally {
      try { if (this.fs.existsSync(temporary)) this.fs.unlinkSync(temporary); } catch { /* best effort */ }
    }
    return document;
  }

  async requestSelection(input = {}) {
    const request = validateRequest(input);
    return withPathQueue(this.filePath, () => {
      const store = this._read();
      const key = `${request.cpsId}:${request.plugEventId}`;
      const existing = store.selections[key] || null;
      if (existing?.status === 'SELECTED') {
        if (JSON.stringify(stableFields(existing)) !== JSON.stringify(stableFields(request))) {
          throw storeError('EXPERIMENTAL_SELECTION_CONFLICT', 'Plug event already has a different immutable AAS selection.', {
            selectionId: existing.selectionId,
          });
        }
        return { outcome: 'NO_OP', selection: clone(existing) };
      }
      if (existing && JSON.stringify(stableFields(existing)) === JSON.stringify(stableFields(request))) {
        return { outcome: 'NO_OP', selection: clone(existing) };
      }
      if (existing && (existing.aasVersion !== request.aasVersion || existing.aasSha256 !== request.aasSha256)) {
        throw storeError('EXPERIMENTAL_SELECTION_CONFLICT', 'Pending Plug event already requests a different AAS version or hash.');
      }
      const plugCycleId = request.plugCycleId || existing?.plugCycleId || null;
      const profileId = request.profileId || existing?.profileId || null;
      if ((existing?.plugCycleId && request.plugCycleId && existing.plugCycleId !== request.plugCycleId) ||
          (existing?.profileId && request.profileId && existing.profileId !== request.profileId)) {
        throw storeError('EXPERIMENTAL_SELECTION_CONFLICT', 'Pending Plug event received divergent lifecycle identity.');
      }
      const complete = Boolean(plugCycleId && profileId);
      const base = { ...request, plugCycleId, profileId };
      const selection = {
        ...base,
        selectionId: complete ? `avm_sel_${hash(base).slice(0, 32)}` : null,
        status: complete ? 'SELECTED' : 'PENDING',
        sourceClassification: 'EXPERIMENTAL_ONLY',
        createdAt: existing?.createdAt || this.now().toISOString(),
        selectedAt: complete ? this.now().toISOString() : null,
      };
      store.selections[key] = selection;
      store.history.push({
        sequence: store.history.length + 1, event: complete ? 'SELECTION_ACCEPTED' : 'SELECTION_PENDING',
        at: this.now().toISOString(), selection: clone(selection),
      });
      this._write(store);
      return { outcome: complete ? 'SELECTED' : 'PENDING', selection: clone(selection) };
    });
  }

  async getSelection({ cpsId, plugEventId } = {}) {
    const key = `${normalizeCpsId(cpsId)}:${text(plugEventId)}`;
    return withPathQueue(this.filePath, () => clone(this._read().selections[key] || null));
  }

  async inspect() {
    return withPathQueue(this.filePath, () => clone(this._read()));
  }
}
