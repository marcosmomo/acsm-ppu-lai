import { GovernanceMigrationPlanner } from '../../lib/governance/governanceMigration.mjs';
import { GovernanceCutoverSimulator } from '../../lib/governance/governanceCutoverSimulator.mjs';

const [workspaceRoot, sourcePath, destinationPath, startPath, rawEvidence = '{}'] = process.argv.slice(2);
while (!(await import('node:fs')).default.existsSync(startPath)) await new Promise((resolve) => setTimeout(resolve, 2));
try {
  const simulator = new GovernanceCutoverSimulator({ workspaceRoot, planner: new GovernanceMigrationPlanner() });
  const result = simulator.execute({ sourcePath, destinationPath, activeCycleEvidence: JSON.parse(rawEvidence), writerSuspended: true });
  process.stdout.write(JSON.stringify({ ok: true, revision: result.baselineRevision }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, code: error.code || error.cause?.code || error.message }));
}
