import fs from 'fs/promises';
import path from 'path';
import { NextResponse } from 'next/server';
import {
  buildCurrentExperimentLog,
  CURRENT_PLUG_PHASE_LOG_FILE,
  parsePlugPhaseLogContent,
} from '../../../lib/reports/plugPhaseExperimentLog';

const LOG_FILE = path.join(process.cwd(), CURRENT_PLUG_PHASE_LOG_FILE);
let writeQueue = Promise.resolve();

async function readLog() {
  try {
    return parsePlugPhaseLogContent(await fs.readFile(LOG_FILE, 'utf-8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return { events: [] };
    throw error;
  }
}

export async function GET() {
  const log = await readLog();
  return NextResponse.json(buildCurrentExperimentLog(log, new Date()));
}

export async function POST(request) {
  try {
    const event = await request.json();
    const now = Date.now();
    const eventType = event?.eventType || event?.type || 'lifecycle_event';
    const cpsId = event?.cpsId || event?.details?.lifecycleCpsId || null;
    const entry = {
      id: event?.id || `evt-${now}-${Math.random().toString(16).slice(2, 8)}`,
      phase: event?.phase || 'plug',
      eventType,
      cpsId,
      cpsName: event?.cpsName || event?.details?.lifecycleCpsName || null,
      topic: event?.topic || event?.baseTopic || event?.details?.lifecycleBaseTopic || null,
      message: event?.message || 'Lifecycle event recorded.',
      details: {
        ...(event?.details || {}),
      },
      ts: event?.ts || now,
      isoDate: new Date(event?.ts || now).toISOString(),
    };

    const writeOperation = writeQueue.then(async () => {
      const log = await readLog();
      const existingEvents = Array.isArray(log?.events) ? log.events : [];
      const eventAlreadyRecorded = entry.id
        ? existingEvents.some((item) => String(item?.id || '') === String(entry.id))
        : false;

      const nextLog = buildCurrentExperimentLog(
        {
          ...log,
          events: eventAlreadyRecorded ? existingEvents : [...existingEvents, entry],
        },
        new Date()
      );

      await fs.mkdir(path.dirname(LOG_FILE), { recursive: true });
      await fs.writeFile(LOG_FILE, JSON.stringify(nextLog, null, 2), 'utf-8');
      return nextLog;
    });

    writeQueue = writeOperation.catch(() => {});
    const nextLog = await writeOperation;
    return NextResponse.json({ ok: true, event: entry, log: nextLog });
  } catch (error) {
    return NextResponse.json(
      {
        error: 'Failed to persist plug log event.',
        details: String(error?.message || error),
      },
      { status: 500 }
    );
  }
}
