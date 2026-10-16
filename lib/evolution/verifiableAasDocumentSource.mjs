import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { buildFunctionalSnapshot } from './functionalNormalizer.mjs';

export const VERIFIABLE_AAS_SOURCE_VERSION = 'verifiable-aas-document-source/1.0.0';

const HASH = /^[a-f0-9]{64}$/;
const clone = (value) => value == null ? value : structuredClone(value);
const text = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;
const normalizeCpsId = (value) => String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '')
  .replace(/^cpslai0+([0-9]+)$/, 'cpslai$1');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function sourceError(code, message, details = undefined) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function immutableCatalog(catalog) {
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
    throw sourceError('AAS_SOURCE_CATALOG_REQUIRED', 'An explicit authorized-reference catalog is required.');
  }
  const entries = new Map();
  for (const [referenceId, raw] of Object.entries(catalog)) {
    const entry = clone(raw);
    if (!text(referenceId) || !text(entry?.locator) || !text(entry?.cpsId) ||
        !text(entry?.aasId) || !text(entry?.assetId) || !HASH.test(String(entry?.contentHash || '').toLowerCase())) {
      throw sourceError('AAS_SOURCE_CATALOG_ENTRY_INVALID', 'Every authorized reference requires locator, identities and SHA-256.', { referenceId });
    }
    entry.cpsId = normalizeCpsId(entry.cpsId);
    entry.contentHash = entry.contentHash.toLowerCase();
    entry.sourceType = text(entry.sourceType) || 'DOCUMENTAL_AAS';
    entry.operational = entry.operational === true;
    entries.set(referenceId, Object.freeze(entry));
  }
  return entries;
}

function parseDocument(bytes, referenceId) {
  try { return JSON.parse(bytes.toString('utf8')); }
  catch (error) {
    throw sourceError('AAS_DOCUMENT_INVALID', 'Authorized AAS bytes are not valid JSON.', {
      referenceId, cause: String(error?.message || error),
    });
  }
}

function documentIdentity(document) {
  const shells = document?.assetAdministrationShells;
  if (!Array.isArray(shells) || shells.length !== 1) {
    throw sourceError('AAS_IDENTITY_INVALID', 'AAS document must contain exactly one Asset Administration Shell.');
  }
  const shell = shells[0];
  const aasId = text(shell?.id);
  const assetId = text(shell?.assetInformation?.globalAssetId);
  if (!aasId || !assetId) throw sourceError('AAS_IDENTITY_INVALID', 'AAS ID and global Asset ID are required.');
  const specificCpsId = (shell?.assetInformation?.specificAssetIds || []).find((item) =>
    String(item?.name || '').trim().toLowerCase() === 'cpsid')?.value;
  const nameplate = (document?.submodels || []).find((item) => item?.idShort === 'DigitalNameplate');
  const nameplateCpsId = (nameplate?.submodelElements || []).find((item) => item?.idShort === 'CPSId')?.value;
  const cpsId = normalizeCpsId(specificCpsId || nameplateCpsId);
  if (!cpsId) throw sourceError('AAS_IDENTITY_INVALID', 'AAS document must declare its CPS identity.');
  return {
    cpsId,
    aasId,
    assetId,
    version: text(shell?.administration?.version),
    revision: text(shell?.administration?.revision),
  };
}

function mismatch(field, expected, actual) {
  return expected != null && String(expected) !== String(actual) ? { field, expected, actual } : null;
}

function declarationProjection(item) {
  return {
    kind: item.kind,
    name: item.name,
    enabled: item.enabled,
    identity: item.identity,
    identityBasis: item.identityBasis,
    technicalIdentity: item.technicalIdentity,
    semanticReferences: clone(item.semanticReferences || []),
    attributes: clone(item.attributes || {}),
    evidenceLevel: item.evidence?.level || 'DECLARED_ONLY',
  };
}

/**
 * Resolves only catalogued references through an injected authorized source.
 * The request never supplies a filesystem path and cannot change provenance.
 */
export function createVerifiableAasDocumentSource({
  catalog,
  source,
  archive = null,
  sourceId = 'authorized-aas-source',
} = {}) {
  const entries = immutableCatalog(catalog);
  if (!source || typeof source.read !== 'function') {
    throw sourceError('AAS_AUTHORIZED_SOURCE_REQUIRED', 'An injected authorized source with read() is required.');
  }
  if (archive && typeof archive.archive !== 'function') {
    throw sourceError('AAS_ARCHIVE_INVALID', 'Injected archive must implement archive().');
  }

  return Object.freeze({
    sourceVersion: VERIFIABLE_AAS_SOURCE_VERSION,
    async resolve(reference = {}, { archive: shouldArchive = true } = {}) {
      const referenceId = text(reference.referenceId);
      const entry = referenceId ? entries.get(referenceId) : null;
      if (!entry) {
        throw sourceError('AAS_REFERENCE_NOT_AUTHORIZED', 'AAS reference is not present in the authorized catalog.', { referenceId });
      }
      const supplied = await source.read({ locator: entry.locator, referenceId });
      const bytes = Buffer.isBuffer(supplied) ? Buffer.from(supplied)
        : supplied instanceof Uint8Array ? Buffer.from(supplied)
          : Buffer.isBuffer(supplied?.bytes) || supplied?.bytes instanceof Uint8Array
            ? Buffer.from(supplied.bytes) : null;
      if (!bytes) throw sourceError('AAS_SOURCE_BYTES_REQUIRED', 'Authorized source did not return document bytes.', { referenceId });

      const contentHash = sha256(bytes);
      if (contentHash !== entry.contentHash) {
        throw sourceError('AAS_CONTENT_HASH_MISMATCH', 'AAS bytes differ from the authorized catalog hash.', {
          referenceId, expected: entry.contentHash, actual: contentHash,
        });
      }
      if (reference.contentHash && String(reference.contentHash).toLowerCase() !== contentHash) {
        throw sourceError('AAS_EXPECTED_HASH_MISMATCH', 'Resolved AAS differs from the expected reference hash.', {
          expected: reference.contentHash, actual: contentHash,
        });
      }

      const document = parseDocument(bytes, referenceId);
      const identity = documentIdentity(document);
      const mismatches = [
        mismatch('cpsId', entry.cpsId, identity.cpsId),
        mismatch('cpsId', reference.cpsId && normalizeCpsId(reference.cpsId), identity.cpsId),
        mismatch('aasId', entry.aasId, identity.aasId),
        mismatch('assetId', entry.assetId, identity.assetId),
        mismatch('aasId', reference.aasId, identity.aasId),
        mismatch('assetId', reference.assetId, identity.assetId),
      ].filter(Boolean);
      if (mismatches.length) {
        throw sourceError('AAS_IDENTITY_MISMATCH', 'Resolved AAS identity does not match its authorized reference.', { referenceId, mismatches });
      }

      const functional = buildFunctionalSnapshot(document);
      const capabilities = functional.declarations.filter((item) => item.kind === 'CAPABILITY').map(declarationProjection);
      const services = functional.declarations.filter((item) => item.kind === 'SERVICE').map(declarationProjection);
      const evidenceLevels = new Set([...capabilities, ...services].map((item) => item.evidenceLevel));
      const evidenceLevel = evidenceLevels.has('DECLARED_ONLY') ? 'DECLARED_ONLY'
        : evidenceLevels.has('BINDING_CONFIRMED') ? 'BINDING_CONFIRMED'
          : evidenceLevels.has('PHYSICALLY_VALIDATED') ? 'PHYSICALLY_VALIDATED' : 'NOT_AVAILABLE';
      const archiveReference = archive && shouldArchive ? await archive.archive({ bytes, expectedHash: contentHash }) : null;

      return {
        schemaVersion: 'verifiable-aas-projection/1.0',
        sourceVersion: VERIFIABLE_AAS_SOURCE_VERSION,
        referenceId,
        cpsId: entry.cpsId,
        aasId: identity.aasId,
        assetId: identity.assetId,
        contentHash,
        version: text(entry.version) || identity.version,
        administration: {
          version: identity.version,
          revision: identity.revision,
        },
        sourceId: text(entry.sourceId) || sourceId,
        sourceType: entry.sourceType,
        operational: entry.operational,
        evidenceLevel,
        completeness: functional.completeness,
        functionalHash: functional.functionalHash,
        functionalSnapshot: functional,
        capabilities,
        services,
        archiveReference,
        physicalStateInferred: false,
      };
    },
  });
}

/** Filesystem adapter for server-side catalogs. Only catalog-owned locators reach read(). */
export function createConfinedAasFileReader({ rootDir, fileSystem = fs } = {}) {
  if (!rootDir || !path.isAbsolute(rootDir)) {
    throw sourceError('AAS_SOURCE_ROOT_REQUIRED', 'Authorized file source requires an absolute rootDir.');
  }
  const root = path.resolve(rootDir);
  return Object.freeze({
    read({ locator } = {}) {
      if (!text(locator) || path.isAbsolute(locator)) throw sourceError('AAS_SOURCE_LOCATOR_INVALID', 'Catalog locator must be relative.');
      const candidate = path.resolve(root, locator);
      const relative = path.relative(root, candidate);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw sourceError('AAS_SOURCE_PATH_ESCAPE', 'Catalog locator escapes the authorized root.');
      }
      const rootReal = fileSystem.realpathSync(root);
      const candidateReal = fileSystem.realpathSync(candidate);
      const realRelative = path.relative(rootReal, candidateReal);
      if (!realRelative || realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
        throw sourceError('AAS_SOURCE_SYMLINK_ESCAPE', 'Authorized AAS resolves outside its source root.');
      }
      return fileSystem.readFileSync(candidateReal);
    },
  });
}
