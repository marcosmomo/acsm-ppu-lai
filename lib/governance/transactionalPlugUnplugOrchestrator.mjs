function orchestrationError(code, message, status = 409, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.details = { code, ...details };
  return error;
}

const clone = (value) => structuredClone(value);

function exactIdentity(input = {}) {
  const identity = {
    cpsId: String(input.cpsId || '').trim(),
    plugEventId: String(input.plugEventId || '').trim(),
    plugCycleId: String(input.plugCycleId || '').trim(),
    profileId: String(input.profileId || '').trim(),
  };
  for (const [key, value] of Object.entries(identity)) {
    if (!value) throw orchestrationError('GOVERNANCE_ORCHESTRATION_IDENTITY_REQUIRED', `${key} is required.`, 400, { field: key });
  }
  return identity;
}

function assertSameRepository(adapters, lifecycleAuthority, evidenceRepository) {
  const repository = adapters?.facade?.repository;
  if (!repository || repository !== lifecycleAuthority?.repository || repository !== evidenceRepository?.repository) {
    throw orchestrationError('GOVERNANCE_ORCHESTRATION_SHARED_REPOSITORY_REQUIRED', 'Facade, lifecycle authority and evidence repository must share the same injected repository instance.', 500);
  }
}

function validatedEvidence(evidenceRepository, identity, operation) {
  const stored = evidenceRepository.readCycle({ identity })[operation === 'PLUG' ? 'plug' : 'unplug'];
  const evidence = stored?.evidence;
  if (stored?.status !== 'VALIDATED' || evidence?.operation !== operation || evidence?.outcome !== 'ACCEPTED' ||
      evidence?.confirmationLevel !== 'BACKEND_ACCEPTED' || evidence.cpsId !== identity.cpsId ||
      evidence.plugEventId !== identity.plugEventId || evidence.plugCycleId !== identity.plugCycleId ||
      evidence.profileId !== identity.profileId) {
    throw orchestrationError('GOVERNANCE_ORCHESTRATION_EVIDENCE_NOT_VALIDATED', `Persisted validated ${operation} evidence is required.`, 409, { ...identity, operation });
  }
  return clone(evidence);
}

/**
 * Isolated coordinator. It only composes injected transactional components;
 * no routes, external services or physical lifecycle commands are invoked.
 * Reservation/evidence/activation and evidence/closure remain separate commits
 * and are recoverable by retrying the same request identity.
 */
export class TransactionalPlugUnplugOrchestrator {
  constructor({ adapters, lifecycleAuthority, evidenceRepository } = {}) {
    assertSameRepository(adapters, lifecycleAuthority, evidenceRepository);
    for (const method of ['reservePlug', 'prepareUnplug', 'activatePlugFromPersistedEvidence', 'closeUnplugFromPersistedEvidence']) {
      if (typeof adapters[method] !== 'function') throw orchestrationError('GOVERNANCE_ORCHESTRATION_ADAPTER_REQUIRED', `Adapter method ${method} is required.`, 500);
    }
    this.adapters = adapters;
    this.lifecycleAuthority = lifecycleAuthority;
    this.evidenceRepository = evidenceRepository;
  }

  plug(input = {}) {
    const reserved = this.adapters.reservePlug(input);
    const identity = exactIdentity({ cpsId: input.cpsId, plugEventId: reserved.plugEventId, plugCycleId: reserved.plugCycleId, profileId: reserved.profileId });
    const lifecycle = this.lifecycleAuthority.transition({ identity, operation: 'PLUG' });
    const evidence = validatedEvidence(this.evidenceRepository, identity, 'PLUG');
    if (evidence.transitionId !== lifecycle.transition.transitionId || evidence.evidenceId !== lifecycle.evidence.evidenceId) {
      throw orchestrationError('GOVERNANCE_ORCHESTRATION_EVIDENCE_CONFLICT', 'Persisted Plug evidence differs from the lifecycle authority result.', 409, identity);
    }
    const activated = this.adapters.activatePlugFromPersistedEvidence(identity);
    return {
      ...identity, cycleState: activated.cycle.state, governanceStatus: activated.profile.status,
      lifecycleState: activated.cycle.authoritativeLifecycleState, confirmationLevel: evidence.confirmationLevel,
      idempotent: reserved.idempotent === true && lifecycle.idempotent === true && activated.idempotent === true,
      reserved, lifecycle: { transition: lifecycle.transition, evidence }, activated,
    };
  }

  unplug(input = {}) {
    const identity = exactIdentity(input);
    const before = this.evidenceRepository.readCycle({ identity });
    if (before.cycle.state !== 'CLOSED') this.adapters.prepareUnplug(identity);
    const lifecycle = this.lifecycleAuthority.transition({ identity, operation: 'UNPLUG' });
    const evidence = validatedEvidence(this.evidenceRepository, identity, 'UNPLUG');
    if (evidence.transitionId !== lifecycle.transition.transitionId || evidence.evidenceId !== lifecycle.evidence.evidenceId) {
      throw orchestrationError('GOVERNANCE_ORCHESTRATION_EVIDENCE_CONFLICT', 'Persisted Unplug evidence differs from the lifecycle authority result.', 409, identity);
    }
    const closed = this.adapters.closeUnplugFromPersistedEvidence(identity);
    return {
      ...identity, cycleState: closed.cycle.state, governanceStatus: closed.profile.status,
      lifecycleState: closed.cycle.authoritativeLifecycleState, confirmationLevel: evidence.confirmationLevel,
      idempotent: lifecycle.idempotent === true && closed.idempotent === true,
      lifecycle: { transition: lifecycle.transition, evidence }, closed,
    };
  }
}
