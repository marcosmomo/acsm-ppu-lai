import fs from 'node:fs';
import { GovernanceRepository } from '../../lib/governance/governanceRepository.mjs';

const [filePath, startFile, field, value] = process.argv.slice(2);
while (!fs.existsSync(startFile)) await new Promise((resolve) => setTimeout(resolve, 2));

try {
  const repository = new GovernanceRepository({ filePath, lockTimeoutMs: 10_000 });
  const committed = repository.transact((draft) => {
    if (field === 'profiles') {
      draft.profiles.concurrentTest = { profileId: value, status: 'PENDING_APPROVAL' };
    } else if (field === 'ppuOutbox') {
      draft.ppuOutbox.concurrentTest = { eventId: value, status: 'PENDING' };
    } else {
      throw new Error('Unsupported isolated worker field.');
    }
    return { field };
  });
  process.stdout.write(JSON.stringify({ ok: true, revision: committed.revision }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, code: error.code, message: error.message }));
}
