import { PlugCycleReservationStore } from '../../lib/acsm/plugCycleReservationStore.mjs';

const [filePath, cpsId, plugEventId, startFile] = process.argv.slice(2);
while (!await import('node:fs').then(({ existsSync }) => existsSync(startFile))) {
  await new Promise((resolve) => setTimeout(resolve, 2));
}
try {
  const result = new PlugCycleReservationStore({ filePath }).reserve({ cpsId, plugEventId, identity: { aasId: 'aas-1' } });
  process.stdout.write(JSON.stringify({ ok: true, result }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, code: error.code, details: error.details }));
}
