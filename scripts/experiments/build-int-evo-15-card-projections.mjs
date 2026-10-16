import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStack } from './run-int-evo-8-dynamic-binding.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const outputPath = path.join(projectRoot, 'docs', 'experiments', 'int-evo-15-card-projections.json');
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'acsm-int-evo-15-'));

const stack = createStack(temporaryRoot);
const scenarios = [];

async function accept({ id, label, eventId, referenceId }) {
  const result = await stack.composition.acceptPlug({
    cpsId: 'cpslai1',
    plugEventId: eventId,
    aasReferenceId: referenceId,
  });
  scenarios.push({ id, label, projection: result.projection });
  return result;
}

const baseline = await accept({
  id: 'baseline', label: 'Initial experimental Plug · BASELINE',
  eventId: 'int-evo-15-baseline', referenceId: 'avm-v1',
});
await stack.composition.unplug(baseline.binding);
scenarios.push({
  id: 'unplug-history',
  label: 'Experimental Unplug · preserved history',
  projection: await stack.composition.readCycle(baseline.binding),
});

const noChange = await accept({
  id: 'no-change', label: 'Same-AAS experimental replug · NO_CHANGE',
  eventId: 'int-evo-15-no-change', referenceId: 'avm-v1',
});
await stack.composition.unplug(noChange.binding);

await accept({
  id: 'changed', label: 'Modified-AAS experimental replug · CHANGED',
  eventId: 'int-evo-15-changed', referenceId: 'avm-v2',
});

const corrupted = structuredClone(scenarios.at(-1).projection);
corrupted.identity.profileId = 'int-evo-15-divergent-profile';
scenarios.push({
  id: 'conflict', label: 'Corrupted projection · CONFLICT', projection: corrupted,
});

const artifact = {
  schemaVersion: 'INT-EVO-15-card-projections/1.0',
  generatedBy: 'scripts/experiments/build-int-evo-15-card-projections.mjs',
  scope: 'PREGENERATED_EXPERIMENTAL_READ_ONLY_DEMONSTRATION',
  simulation: true,
  operational: false,
  physicalExecution: false,
  sourceComposition: 'INT-EVO-8 AcceptedCycleAasComposition',
  queryContract: 'evolution-cycle-query/1.0.0',
  scenarios,
};

fs.writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify({ outputPath, scenarios: scenarios.map(({ id, projection }) => ({
  id,
  correlationStatus: projection.correlationStatus,
  bindingStatus: projection.bindingStatus,
  evolutionStatus: projection.evolutionStatus,
  cycleState: projection.cycle?.state,
})) }, null, 2)}\n`);
