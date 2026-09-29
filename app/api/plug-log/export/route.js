import fs from 'fs/promises';
import path from 'path';
import {
  buildCurrentExperimentLog,
  parsePlugPhaseLogContent,
} from '../../../../lib/reports/plugPhaseExperimentLog';

const LOG_FILE = path.join(process.cwd(), 'data', 'plug-phase-log.json');

export async function GET() {
  try {
    const raw = await fs.readFile(LOG_FILE, 'utf-8');

    // valida se o JSON está correto antes de exportar
    const parsed = buildCurrentExperimentLog(parsePlugPhaseLogContent(raw), new Date());

    const fileName = `plug-phase-log-${new Date()
      .toISOString()
      .replace(/[:.]/g, '-')}.json`;

    return new Response(JSON.stringify(parsed, null, 2), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${fileName}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    return Response.json(
      {
        error: 'Failed to export plug log file.',
        details: String(error?.message || error),
      },
      { status: 500 }
    );
  }
}
