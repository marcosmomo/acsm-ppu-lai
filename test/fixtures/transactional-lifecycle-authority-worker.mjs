import fs from 'node:fs';
import { GovernanceRepository } from '../../lib/governance/governanceRepository.mjs';
import { TransactionalLifecycleAuthority } from '../../lib/governance/transactionalLifecycleAuthority.mjs';

const [filePath, startPath, identityJson, operation] = process.argv.slice(2);
while (!fs.existsSync(startPath)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
const source = { system: 'acsm-isolated', component: 'transactional-lifecycle-authority', instanceId: 'worker-fixture' };
try {
  const repository = new GovernanceRepository({ filePath, lockTimeoutMs: 10000, retryMs: 2 });
  const authority = new TransactionalLifecycleAuthority({
    repository, source, now: () => '2026-10-14T18:00:00.000Z',
    verifyTransitionResult: (_result, { permission, source: descriptor }) => ({
      verified: true,
      principal: { type: 'LIFECYCLE_AUTHORITY', ...descriptor },
      authorizationId: 'server-test-authority', scheme: 'injected-isolated-verifier',
      claimsHash: 'test-claims-digest', permission,
    }),
  });
  const result = authority.transition({ identity: JSON.parse(identityJson), operation });
  process.stdout.write(JSON.stringify({ idempotent: result.idempotent, transitionId: result.transition.transitionId, evidenceId: result.evidence.evidenceId }));
} catch (error) {
  process.stderr.write(`${error.code || error.name}: ${error.message}`);
  process.exitCode = 1;
}
