import { createHash } from 'node:crypto';
import { stableStringify } from './functionalNormalizer.mjs';
import { extractFunctionalDeclarations } from './functionalExtractor.mjs';

export const AAS_RESOLVER_VERSION = 'aas-resolver/1.0.0';

const normalizeCpsId = (value) => String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '')
  .replace(/^cpslai0+([123])$/, 'cpslai$1');
const supportedCps = new Set(['cpslai1', 'cpslai2', 'cpslai3']);
const clone = (value) => JSON.parse(JSON.stringify(value));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const text = (value) => value == null ? '' : String(value).trim();

function resolverError(code, message, details = undefined) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function propertyValue(document, submodelIdShort, propertyIdShort) {
  const submodel = (document?.submodels || []).find((item) => item?.idShort === submodelIdShort);
  return (submodel?.submodelElements || []).find((item) => item?.idShort === propertyIdShort)?.value ?? null;
}

function documentCpsId(document) {
  const shell = document?.assetAdministrationShells?.[0];
  const specific = (shell?.assetInformation?.specificAssetIds || []).find((item) =>
    String(item?.name || '').toLowerCase() === 'cpsid');
  return normalizeCpsId(specific?.value || propertyValue(document, 'DigitalNameplate', 'CPSId'));
}

function validateDocument(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw resolverError('AAS_DOCUMENT_INVALID', 'Resolved AAS document must be an object.');
  }
  if (!Array.isArray(document.assetAdministrationShells) || document.assetAdministrationShells.length !== 1) {
    throw resolverError('AAS_SHELL_INVALID', 'Resolved document must contain exactly one Asset Administration Shell.');
  }
  const shell = document.assetAdministrationShells[0];
  if (!text(shell?.id) || !shell?.assetInformation || !text(shell.assetInformation.globalAssetId)) {
    throw resolverError('AAS_IDENTITY_INCOMPLETE', 'AAS id and globalAssetId are required.');
  }
  if (!Array.isArray(document.submodels)) {
    throw resolverError('AAS_SUBMODELS_INVALID', 'Resolved document must contain a submodels array.');
  }
  return shell;
}

function mismatch(field, expected, actual) {
  if (expected == null || expected === '') return null;
  return String(expected) === String(actual ?? '') ? null : { field, expected, actual: actual ?? null };
}

function validateExpectedReference(expected, resolved) {
  const mismatches = [
    mismatch('aasId', expected?.aasId, resolved.aasId),
    mismatch('assetId', expected?.assetId, resolved.assetId),
    mismatch('version', expected?.version, resolved.version),
    mismatch('revision', expected?.revision, resolved.revision),
    mismatch('contentHash', expected?.contentHash?.toLowerCase?.(), resolved.contentHash.toLowerCase()),
  ].filter(Boolean);
  if (mismatches.length) {
    throw resolverError('AAS_EXPECTED_REFERENCE_MISMATCH', 'Resolved AAS does not match the expected immutable reference.', { mismatches });
  }
}

export async function resolveCompleteAas({
  cpsId,
  expectedReference = {},
  source,
  archive = null,
  policy = {},
  now = () => new Date(),
} = {}) {
  const normalizedCpsId = normalizeCpsId(cpsId);
  if (!supportedCps.has(normalizedCpsId)) {
    throw resolverError('AAS_CPS_UNSUPPORTED', 'Resolver accepts only CPS-LAI-01, CPS-LAI-02 and CPS-LAI-03.');
  }
  if (!source || typeof source.resolve !== 'function') {
    throw resolverError('AAS_SOURCE_REQUIRED', 'An explicitly configured AAS source is required.');
  }
  const supplied = await source.resolve({ cpsId: normalizedCpsId, expectedReference: clone(expectedReference) });
  const document = supplied?.document;
  const shell = validateDocument(document);
  const resolvedCpsId = documentCpsId(document);
  if (!resolvedCpsId) throw resolverError('AAS_CPS_ID_MISSING', 'Resolved AAS does not declare a CPS identity.');
  if (resolvedCpsId !== normalizedCpsId) {
    throw resolverError('AAS_CPS_ID_MISMATCH', 'Resolved AAS belongs to a different CPS.', {
      expectedCpsId: normalizedCpsId,
      actualCpsId: resolvedCpsId,
    });
  }

  const rawBytes = supplied?.rawBytes == null
    ? Buffer.from(stableStringify(document), 'utf8')
    : Buffer.isBuffer(supplied.rawBytes) ? supplied.rawBytes : Buffer.from(supplied.rawBytes);
  const contentHash = sha256(rawBytes);
  const canonicalHash = sha256(stableStringify(document));
  const extraction = extractFunctionalDeclarations(document);
  const completeness = extraction.completeness;
  const pendingValidation = extraction.issues.map((issue) => clone(issue));
  const identity = {
    cpsId: resolvedCpsId,
    aasId: shell.id,
    aasIdShort: shell.idShort || null,
    assetId: shell.assetInformation.globalAssetId,
    version: shell.administration?.version || null,
    revision: shell.administration?.revision || null,
  };
  validateExpectedReference(expectedReference, { ...identity, contentHash });
  if (policy.requireFunctionalCompleteness === true && completeness === 'INCOMPLETE') {
    throw resolverError('AAS_FUNCTIONALLY_INCOMPLETE', 'Resolved AAS does not satisfy the required functional completeness policy.', {
      pendingValidation,
    });
  }
  if (policy.requireOperationalSource === true && supplied?.provenance?.operational !== true) {
    throw resolverError('AAS_OPERATIONAL_SOURCE_REQUIRED', 'Configured policy requires an operational AAS source.');
  }

  if (archive != null && typeof archive.archive !== 'function') {
    throw resolverError('AAS_ARCHIVE_INVALID', 'Injected AAS archive must expose archive({ bytes, expectedHash }).');
  }
  const archiveReference = archive
    ? await archive.archive({ bytes: rawBytes, expectedHash: contentHash })
    : null;
  if (archiveReference && archiveReference.contentHash !== contentHash) {
    throw resolverError('AAS_ARCHIVE_HASH_MISMATCH', 'AAS archive returned a reference for different source bytes.');
  }

  const provenance = {
    resolverVersion: AAS_RESOLVER_VERSION,
    sourceId: supplied?.provenance?.sourceId || source.sourceId || null,
    sourceType: supplied?.provenance?.sourceType || source.sourceType || 'INJECTED',
    operational: supplied?.provenance?.operational === true,
    locator: supplied?.provenance?.locator || null,
    sourceRevision: supplied?.provenance?.sourceRevision || null,
  };
  const resolutionInstant = now();
  const resolvedAt = (resolutionInstant instanceof Date ? resolutionInstant : new Date(resolutionInstant)).toISOString();
  const resolvedReference = {
    ...identity,
    contentHash,
    canonicalHash,
    sourceId: provenance.sourceId,
    sourceRevision: provenance.sourceRevision,
    locator: provenance.locator,
    archiveReference: archiveReference?.reference || null,
  };

  return {
    schemaVersion: '1.0',
    resolverVersion: AAS_RESOLVER_VERSION,
    document: clone(document),
    // Exact bytes used for contentHash and archive, never a second source read.
    rawBytes: Buffer.from(rawBytes),
    identity,
    provenance,
    integrity: { algorithm: 'SHA-256', contentHash, canonicalHash },
    resolvedReference,
    archiveReference,
    resolvedAt,
    completeness,
    pendingValidation,
    evidenceScope: 'STATIC_DOCUMENT_DECLARATION',
    physicalStateInferred: false,
  };
}
