import fs from 'node:fs';
import { GovernanceRepository } from '../../lib/governance/governanceRepository.mjs';
import { LifecycleEvidenceRepository } from '../../lib/governance/lifecycleEvidenceRepository.mjs';
import { LIFECYCLE_CONFIRMATION_LEVELS as LEVEL } from '../../lib/governance/lifecycleEvidence.mjs';

const [filePath, startPath, identityJson, evidenceJson] = process.argv.slice(2);
while (!fs.existsSync(startPath)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
const evidence = JSON.parse(evidenceJson);
const source = evidence.source;
const verifyEvidenceOrigin = (_record, { permission }) => ({
  verified: true,
  principal: { type: 'LIFECYCLE_AUTHORITY', ...source },
  authorizationId: 'auth-fixture-1', scheme: 'test-verifier',
  claimsHash: 'claims-fixture-hash', permission,
});
try {
  const repository = new GovernanceRepository({ filePath, lockTimeoutMs: 10000, retryMs: 2 });
  const store = new LifecycleEvidenceRepository({
    repository,
    verifyEvidenceOrigin,
    confirmationPolicy: { minimumConfirmationLevel: LEVEL.BACKEND_ACCEPTED },
    now: () => '2026-10-14T15:00:02.000Z',
    resolveExpectedPreviousState: () => 'idle',
  });
  const result = store.record({ identity: JSON.parse(identityJson), evidence });
  process.stdout.write(JSON.stringify({ idempotent: result.idempotent, revision: repository.read().revision }));
} catch (error) {
  if (error.code === 'LIFECYCLE_TRANSITION_ID_CONFLICT') {
    process.stdout.write(JSON.stringify({ status: error.code }));
  } else {
    process.stderr.write(`${error.code || error.name}: ${error.message}`);
    process.exitCode = 1;
  }
}
