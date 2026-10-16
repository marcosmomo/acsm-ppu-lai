import fs from 'node:fs/promises';
import path from 'node:path';

export async function ensureHcmStructure(root) {
  const dirs = ['episodes', 'events', 'knowledge'];
  for (const dir of dirs) await fs.mkdir(path.join(root, dir), { recursive: true });
  const manifestPath = path.join(root, 'manifest.json');
  try { await fs.access(manifestPath); }
  catch {
    const temp = `${manifestPath}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify({ schemaVersion: '1.0', cpsId: 'cpslai1', initializedAt: new Date().toISOString() }, null, 2)}\n`, { flag: 'wx' });
    await fs.rename(temp, manifestPath);
  }
  return { manifestPath, createdEpisodes: 0 };
}

export async function appendHcmEvent(root, event) {
  if (!event?.episodeId || !event?.eventType || !event?.eventId) throw new Error('HCM event requires eventId, episodeId and eventType.');
  if (![event.episodeId, event.eventId].every((value) => /^[A-Za-z0-9_-]{1,128}$/.test(value))) throw new Error('HCM identifiers contain unsupported characters.');
  const date = new Date(event.occurredAt || Date.now());
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid HCM event timestamp.');
  try { await fs.access(path.join(root, 'episodes', `${event.episodeId}.json`)); }
  catch { throw new Error('HCM episode must exist before appending an event.'); }
  const dir = path.join(root, 'events');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${date.toISOString().slice(0, 7)}.jsonl`);
  const handle = await fs.open(file, 'a');
  try { await handle.write(`${JSON.stringify({ ...event, occurredAt: date.toISOString() })}\n`); await handle.sync(); }
  finally { await handle.close(); }
  return file;
}

export async function createHcmEpisode(root, episode) {
  if (!episode?.episodeId || episode.cpsId !== 'cpslai1') throw new Error('HCM episode requires episodeId and cpsId=cpslai1.');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(episode.episodeId)) throw new Error('HCM episode identifier contains unsupported characters.');
  const dir = path.join(root, 'episodes');
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, `${episode.episodeId}.json`);
  const temp = `${target}.tmp`;
  const handle = await fs.open(temp, 'wx');
  try { await handle.writeFile(`${JSON.stringify({ schemaVersion: '1.0', ...episode }, null, 2)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  await fs.rename(temp, target);
  return target;
}
