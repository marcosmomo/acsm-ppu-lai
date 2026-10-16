import fs from 'node:fs';
import { GovernanceRepository } from '../../lib/governance/governanceRepository.mjs';
import { TransactionalGovernanceFacade } from '../../lib/governance/transactionalGovernanceFacade.mjs';
import { TransactionalGovernanceAdapters } from '../../lib/governance/transactionalGovernanceAdapters.mjs';
import { buildPpuEvent } from '../../lib/acsm/ppuEventBuilder.mjs';

const [filePath, startFile, operation, rawInput = '{}'] = process.argv.slice(2);
const input = JSON.parse(rawInput);
while (!fs.existsSync(startFile)) await new Promise((resolve) => setTimeout(resolve, 2));

const facade = new TransactionalGovernanceFacade({ repository: new GovernanceRepository({ filePath, lockTimeoutMs: 10_000 }) });
const adapters = new TransactionalGovernanceAdapters({ facade });
try {
  let result;
  if (operation === 'updatePolicies') result = facade.updatePolicies(input);
  else if (operation === 'adapterReserve') result = adapters.reservePlug(input);
  else if (operation === 'reserveCycle') result = facade.reserveAndCreatePendingProfile(input);
  else if (operation === 'activateCycle') result = facade.activateCycle(input);
  else if (operation === 'failCycle') result = facade.recordCycleFailure(input);
  else if (operation === 'closeCycle') result = facade.closeCorrelatedCycle(input);
  else if (operation === 'approve') result = facade.approveProfile(input);
  else if (operation === 'reject') result = facade.rejectProfile(input);
  else if (operation === 'history') result = facade.recordHistory(input);
  else if (operation === 'decideAction') result = facade.decideAction(input);
  else if (operation === 'createProfile') result = facade.createPendingProfile(input);
  else if (operation === 'outbox') result = facade.enqueueOutbox(buildPpuEvent(input));
  else throw new Error('Unsupported isolated operation.');
  process.stdout.write(JSON.stringify({ ok: true, result }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, code: error.code, message: error.message }));
}
