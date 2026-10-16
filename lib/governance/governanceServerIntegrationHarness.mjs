import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildHumanDecisionCommand,
  buildLifecycleCommitCommand,
  buildPlugIntegrationCommand,
  requireExpectedRevision,
  requireServerHumanAuthorization,
} from './cutoverIntegrationContracts.mjs';
import { compareGovernanceShadows } from './governanceShadowComparator.mjs';
import { translateGovernanceAdapterError } from './transactionalGovernanceAdapters.mjs';
import { GOVERNANCE_PERMISSIONS } from './serverGovernanceAuthorization.mjs';

export const GOVERNANCE_HARNESS_MODES = Object.freeze({
  SHADOW_READ_ONLY: 'SHADOW_READ_ONLY',
  ISOLATED_TRANSACTIONAL_TEST: 'ISOLATED_TRANSACTIONAL_TEST',
});

export const GOVERNANCE_HARNESS_OPERATIONS = Object.freeze({
  SHADOW_COMPARE: 'SHADOW_COMPARE',
  GET_PROFILE: 'GET_PROFILE',
  PLUG: 'PLUG',
  ACTIVATE_PLUG: 'ACTIVATE_PLUG',
  APPROVE_PROFILE: 'APPROVE_PROFILE',
  REJECT_PROFILE: 'REJECT_PROFILE',
  UPDATE_POLICIES: 'UPDATE_POLICIES',
  PLAY_GATE: 'PLAY_GATE',
  UNPLUG: 'UNPLUG',
  CREATE_GOVERNED_ACTION: 'CREATE_GOVERNED_ACTION',
  DECIDE_GOVERNED_ACTION: 'DECIDE_GOVERNED_ACTION',
  LIST_OUTBOX: 'LIST_OUTBOX',
});

function harnessError(code, message, status = 400, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.details = { code, ...details };
  return error;
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

/**
 * Fail-closed test-path proof. The caller must provide an existing, non-symlink
 * temporary root below os.tmpdir(), and the Repository path must be inside it.
 */
export function assertIsolatedGovernanceTestPath({ storePath, temporaryRoot } = {}) {
  if (!path.isAbsolute(storePath || '') || !path.isAbsolute(temporaryRoot || '')) {
    throw harnessError('GOVERNANCE_HARNESS_ABSOLUTE_PATHS_REQUIRED', 'Absolute storePath and temporaryRoot are required.');
  }
  const rootStat = fs.lstatSync(temporaryRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw harnessError('GOVERNANCE_HARNESS_TEMP_ROOT_INVALID', 'temporaryRoot must be a real directory, not a symbolic link.');
  }
  const systemTemp = fs.realpathSync(os.tmpdir());
  const root = fs.realpathSync(temporaryRoot);
  if (root !== systemTemp && !isInside(systemTemp, root)) {
    throw harnessError('GOVERNANCE_HARNESS_NON_TEMP_PATH_FORBIDDEN', 'Transactional harness paths must be below the system temporary directory.', 403);
  }
  const resolvedStore = path.resolve(storePath);
  if (!isInside(root, resolvedStore)) {
    throw harnessError('GOVERNANCE_HARNESS_STORE_OUTSIDE_TEMP_ROOT', 'Repository storePath must be inside temporaryRoot.', 403);
  }
  const parent = fs.realpathSync(path.dirname(resolvedStore));
  if (parent !== root && !isInside(root, parent)) {
    throw harnessError('GOVERNANCE_HARNESS_STORE_PARENT_ESCAPE', 'Repository parent resolves outside temporaryRoot.', 403);
  }
  if (fs.existsSync(resolvedStore) && fs.realpathSync(resolvedStore) !== resolvedStore) {
    throw harnessError('GOVERNANCE_HARNESS_STORE_SYMLINK_FORBIDDEN', 'Repository storePath cannot be a symbolic link.', 403);
  }
  return Object.freeze({ temporaryRoot: root, storePath: resolvedStore });
}

function invokeProvider(provider, request, name) {
  if (typeof provider !== 'function') throw harnessError(`GOVERNANCE_${name}_PROVIDER_BLOCKED`, `${name} provider is not configured.`, 503);
  const value = provider(structuredClone(request));
  if (value && typeof value.then === 'function') {
    throw harnessError(`GOVERNANCE_${name}_PROVIDER_ASYNC_FORBIDDEN`, `${name} provider must be an isolated synchronous test provider.`);
  }
  return value;
}

function serverAuthorization(provider, request, permission) {
  const context = invokeProvider(provider, { ...request, requiredPermission: permission }, 'AUTHORIZATION');
  if (!context || context.authenticated !== true) {
    throw harnessError('GOVERNANCE_AUTHENTICATION_REQUIRED', 'Server-side authentication is required.', 401);
  }
  if (context.authorized !== true) {
    throw harnessError('GOVERNANCE_AUTHORIZATION_REQUIRED', 'The authenticated principal is not authorized.', 403);
  }
  try {
    requireServerHumanAuthorization(context, permission);
  } catch (error) {
    throw harnessError('GOVERNANCE_AUTHORIZATION_CONTEXT_INVALID', 'Server-side authorization context is incomplete or untrusted.', 403, { causeCode: error.code });
  }
  return context;
}

function requestParts(request = {}) {
  return {
    operation: String(request.operation || '').trim().toUpperCase(),
    params: request.params && typeof request.params === 'object' ? request.params : {},
    body: request.body && typeof request.body === 'object' ? request.body : {},
  };
}

function success(payload, status = 200) {
  return Object.freeze({ status, headers: Object.freeze({ 'Cache-Control': 'no-store' }), body: Object.freeze({ ok: true, ...structuredClone(payload) }) });
}

function failure(error) {
  const translated = translateGovernanceAdapterError(error);
  return Object.freeze({
    status: Number(error?.status) || translated.status,
    headers: Object.freeze({ 'Cache-Control': 'no-store' }),
    body: Object.freeze({
      ok: false,
      error: error?.message || translated.error,
      details: structuredClone({ ...translated.details, ...(error?.details || {}), code: translated.details.code }),
    }),
  });
}

function correlatedInput(params, body) {
  return {
    cpsId: params.cpsId ?? body.cpsId,
    plugEventId: body.plugEventId,
    plugCycleId: body.plugCycleId,
    profileId: body.profileId,
    expectedRevision: body.expectedRevision,
  };
}

function withRevision(adapters, payload) {
  return { ...payload, expectedRevision: adapters.facade.read().revision };
}

export function createGovernanceServerIntegrationHarness({
  mode,
  adapters = null,
  storePath = null,
  temporaryRoot = null,
  authorizationProvider = null,
  lifecycleEvidenceProvider = null,
  comparator = compareGovernanceShadows,
} = {}) {
  if (!Object.values(GOVERNANCE_HARNESS_MODES).includes(mode)) {
    throw harnessError('GOVERNANCE_HARNESS_MODE_REQUIRED', 'An explicit supported harness mode is required.');
  }

  if (mode === GOVERNANCE_HARNESS_MODES.SHADOW_READ_ONLY) {
    if (adapters || storePath || temporaryRoot || authorizationProvider || lifecycleEvidenceProvider) {
      throw harnessError('GOVERNANCE_SHADOW_DEPENDENCY_FORBIDDEN', 'Shadow harness cannot receive writers, stores, authorization or lifecycle providers.');
    }
    return Object.freeze({
      mode,
      readiness: Object.freeze({ status: 'BLOCKED', blockers: ['OPERATIONAL_AUTHENTICATION', 'AUTHORITATIVE_LIFECYCLE_EVIDENCE', 'OPERATIONAL_WRITER_CUTOVER'] }),
      handle(request = {}) {
        try {
          const { operation, body } = requestParts(request);
          if (operation !== GOVERNANCE_HARNESS_OPERATIONS.SHADOW_COMPARE) {
            throw harnessError('GOVERNANCE_SHADOW_OPERATION_FORBIDDEN', 'Shadow mode only supports read-only comparison.', 405);
          }
          return success({ comparison: comparator(body) });
        } catch (error) { return failure(error); }
      },
    });
  }

  if (!adapters?.facade?.repository) {
    throw harnessError('GOVERNANCE_HARNESS_ADAPTERS_REQUIRED', 'Injected transactional adapters with a Repository are required.');
  }
  const proof = assertIsolatedGovernanceTestPath({ storePath, temporaryRoot });
  if (path.resolve(adapters.facade.repository.filePath || '') !== proof.storePath) {
    throw harnessError('GOVERNANCE_HARNESS_REPOSITORY_PATH_CONFLICT', 'Injected Repository does not use the proven temporary storePath.', 403);
  }

  const handlers = {
    [GOVERNANCE_HARNESS_OPERATIONS.GET_PROFILE]: ({ params, body }) => adapters.getProfile(params.cpsId ?? body.cpsId),
    [GOVERNANCE_HARNESS_OPERATIONS.PLUG]: ({ params, body }) => {
      const command = buildPlugIntegrationCommand({ ...body, cpsId: params.cpsId ?? body.cpsId });
      const expectedRevision = requireExpectedRevision(body.expectedRevision);
      return adapters.reservePlug({ ...command, cps: body.cps || {}, initialPpuEvent: body.initialPpuEvent || null, expectedRevision });
    },
    [GOVERNANCE_HARNESS_OPERATIONS.ACTIVATE_PLUG]: ({ params, body, request }) => {
      const input = correlatedInput(params, body);
      const evidence = invokeProvider(lifecycleEvidenceProvider, { ...request, expectedIdentity: input, expectedPhase: 'plug' }, 'LIFECYCLE_EVIDENCE');
      const command = buildLifecycleCommitCommand({ ...input, evidence }, 'plug');
      return adapters.activatePlug({ ...command, lifecycleEvidence: command.evidence });
    },
    [GOVERNANCE_HARNESS_OPERATIONS.APPROVE_PROFILE]: ({ params, body, request }) => {
      const authorization = serverAuthorization(authorizationProvider, request, GOVERNANCE_PERMISSIONS.PROFILE_APPROVE);
      const command = buildHumanDecisionCommand({ ...correlatedInput(params, body), decision: 'APPROVED', authorization });
      return adapters.approveProfile({ ...command, authorization });
    },
    [GOVERNANCE_HARNESS_OPERATIONS.REJECT_PROFILE]: ({ params, body, request }) => {
      const authorization = serverAuthorization(authorizationProvider, request, GOVERNANCE_PERMISSIONS.PROFILE_REJECT);
      const command = buildHumanDecisionCommand({ ...correlatedInput(params, body), decision: 'DENIED', authorization });
      return adapters.rejectProfile({ ...command, authorization });
    },
    [GOVERNANCE_HARNESS_OPERATIONS.UPDATE_POLICIES]: ({ params, body, request }) => {
      const authorization = serverAuthorization(authorizationProvider, request, GOVERNANCE_PERMISSIONS.POLICY_UPDATE);
      requireServerHumanAuthorization(authorization, GOVERNANCE_PERMISSIONS.POLICY_UPDATE);
      return adapters.updatePolicies({ ...correlatedInput(params, body), policies: body.policies, authorization });
    },
    [GOVERNANCE_HARNESS_OPERATIONS.PLAY_GATE]: ({ params, body }) => adapters.projectPlayGate({
      ...correlatedInput(params, body), lifecyclePhase: body.lifecyclePhase, expectedPhase: body.expectedPhase || 'play',
    }),
    [GOVERNANCE_HARNESS_OPERATIONS.UNPLUG]: ({ params, body, request }) => {
      const input = correlatedInput(params, body);
      adapters.prepareUnplug(input);
      const evidence = invokeProvider(lifecycleEvidenceProvider, { ...request, expectedIdentity: input, expectedPhase: 'unplug' }, 'LIFECYCLE_EVIDENCE');
      const command = buildLifecycleCommitCommand({ ...input, evidence }, 'unplug');
      return adapters.closeUnplug({ ...command, unplugEvidence: command.evidence });
    },
    [GOVERNANCE_HARNESS_OPERATIONS.CREATE_GOVERNED_ACTION]: ({ params, body }) => {
      requireExpectedRevision(body.expectedRevision);
      return adapters.createGovernedAction({ ...body, cpsId: params.cpsId ?? body.cpsId });
    },
    [GOVERNANCE_HARNESS_OPERATIONS.DECIDE_GOVERNED_ACTION]: ({ params, body, request }) => {
      const permission = String(body.decision || '').toUpperCase() === 'APPROVED'
        ? GOVERNANCE_PERMISSIONS.ACTION_APPROVE : GOVERNANCE_PERMISSIONS.ACTION_REJECT;
      const authorization = serverAuthorization(authorizationProvider, request, permission);
      requireExpectedRevision(body.expectedRevision);
      return adapters.decideGovernedAction({ ...body, actionId: params.actionId ?? body.actionId, authorization });
    },
    [GOVERNANCE_HARNESS_OPERATIONS.LIST_OUTBOX]: () => ({ ppuOutbox: adapters.listOutbox(), published: false, effects: [] }),
  };

  return Object.freeze({
    mode,
    pathProof: proof,
    readiness: Object.freeze({ status: 'BLOCKED', blockers: ['TEST_AUTHORIZATION_ONLY', 'TEST_LIFECYCLE_EVIDENCE_ONLY', 'NO_OPERATIONAL_DISPATCHER', 'NO_OPERATIONAL_CUTOVER'] }),
    handle(request = {}) {
      try {
        const parts = requestParts(request);
        const handler = handlers[parts.operation];
        if (!handler) throw harnessError('GOVERNANCE_HARNESS_OPERATION_NOT_SUPPORTED', 'Harness operation is not supported.', 405, { operation: parts.operation });
        const payload = handler({ ...parts, request: structuredClone(request) });
        const responseStatus = parts.operation === GOVERNANCE_HARNESS_OPERATIONS.PLAY_GATE
          ? Number(payload?.status) || 200
          : 200;
        return success(withRevision(adapters, payload), responseStatus);
      } catch (error) { return failure(error); }
    },
  });
}
