import fs from 'node:fs/promises';
import path from 'node:path';

async function durableAppend(file, value) {
  await fs.mkdir(path.dirname(path.resolve(file)), { recursive: true });
  const handle = await fs.open(file, 'a');
  try {
    await handle.write(`${JSON.stringify(value)}\n`);
    await handle.sync();
  } finally { await handle.close(); }
}

export class PersistentSpool {
  constructor(file, deadLetterFile) {
    this.file = file;
    this.deadLetterFile = deadLetterFile;
    this.pending = new Map();
    this.rejected = new Set();
    this.loaded = false;
    this.serial = Promise.resolve();
  }

  async load() {
    if (this.loaded) return [...this.pending.values()];
    try {
      const content = await fs.readFile(this.file, 'utf8');
      for (const line of content.split(/\r?\n/).filter(Boolean)) {
        const entry = JSON.parse(line);
        this.pending.set(entry.dedupeKey, entry);
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.loaded = true;
    return [...this.pending.values()];
  }

  enqueue(entry) {
    const operation = this.serial.then(async () => {
      await this.load();
      if (this.pending.has(entry.dedupeKey)) return { duplicate: true };
      await durableAppend(this.file, entry);
      this.pending.set(entry.dedupeKey, entry);
      return { duplicate: false };
    });
    this.serial = operation.catch(() => {});
    return operation;
  }

  async reject(entry, errors) {
    if (!this.rejectedLoaded) {
      try {
        const content = await fs.readFile(this.deadLetterFile, 'utf8');
        for (const line of content.split(/\r?\n/).filter(Boolean)) this.rejected.add(JSON.parse(line).dedupeKey);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      this.rejectedLoaded = true;
    }
    if (entry.dedupeKey && this.rejected.has(entry.dedupeKey)) return;
    await durableAppend(this.deadLetterFile, { ...entry, rejectedAt: new Date().toISOString(), errors });
    if (entry.dedupeKey) this.rejected.add(entry.dedupeKey);
  }

  acknowledge(dedupeKey) {
    const operation = this.serial.then(async () => {
      await this.load();
      if (!this.pending.has(dedupeKey)) return;
      const next = [...this.pending.values()].filter((entry) => entry.dedupeKey !== dedupeKey);
      const target = path.resolve(this.file);
      await fs.mkdir(path.dirname(target), { recursive: true });
      const temp = `${target}.tmp`;
      const handle = await fs.open(temp, 'w');
      try {
        if (next.length) await handle.writeFile(`${next.map(JSON.stringify).join('\n')}\n`);
        await handle.sync();
      } finally { await handle.close(); }
      await fs.rename(temp, target);
      this.pending.delete(dedupeKey);
    });
    this.serial = operation.catch(() => {});
    return operation;
  }

  size() { return this.pending.size; }
}
