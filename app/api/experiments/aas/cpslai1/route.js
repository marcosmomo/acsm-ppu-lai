import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';

import {
  buildExperimentalRefreshDiagnostics,
  readExperimentalEditableAas,
} from '../../../../../lib/evolution/experimentalEditableAasSource.mjs';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const NO_CACHE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  Pragma: 'no-cache',
  Expires: '0',
};

const experimentalSessions = new Map();
const MAX_EXPERIMENTAL_SESSIONS = 100;
const serverInstanceId = `experimental-${randomUUID().slice(0, 8)}`;

function sessionId(request) {
  const value = request.headers.get('x-experimental-aas-session');
  if (!value || !/^[a-zA-Z0-9-]{16,80}$/.test(value)) {
    throw Object.assign(new Error('Experimental AAS session identifier is invalid.'), { code: 'EXPERIMENTAL_SESSION_INVALID' });
  }
  return value;
}

export async function GET(request) {
  try {
    const id = sessionId(request);
    const previousEntry = experimentalSessions.get(id) || null;
    const result = await readExperimentalEditableAas({ previousSnapshot: previousEntry?.snapshot || null });
    const diagnostics = buildExperimentalRefreshDiagnostics({
      id,
      instanceId: serverInstanceId,
      previousEntry,
      result,
    });
    if (!experimentalSessions.has(id) && experimentalSessions.size >= MAX_EXPERIMENTAL_SESSIONS) {
      experimentalSessions.delete(experimentalSessions.keys().next().value);
    }
    experimentalSessions.set(id, {
      snapshot: result.snapshot,
      documentHash: result.projection.contentHash,
    });
    return NextResponse.json({ ...result, diagnostics }, { headers: NO_CACHE_HEADERS });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      code: error?.code || 'EXPERIMENTAL_AAS_REFRESH_FAILED',
      error: error?.message || 'Experimental AAS refresh failed.',
    }, { status: 422, headers: NO_CACHE_HEADERS });
  }
}
