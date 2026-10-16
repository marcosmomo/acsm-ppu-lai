import { NextResponse } from 'next/server';
import {
  getPlugState,
  transitionPlugAssetLifecycle,
  updatePlugSnapshot,
} from '../../../../lib/acsm/plugStore.mjs';
import { executeAcsmUnplug } from '../../../../lib/acsm/unplugLifecycle.mjs';
import {
  closeGovernancePlugCycle,
  createGovernanceProfileForPlug,
  enqueuePpuOutboxEvent,
  getActiveGovernanceProfile,
} from '../../../../services/governance/governanceStore.js';
import { buildPlugRequestedPpuEvent } from '../../../../lib/acsm/ppuEventBuilder.mjs';
import { sanitizeOutboxError } from '../../../../lib/acsm/ppuOutbox.mjs';
import { createPlugPostHandler } from '../../../../lib/acsm/plugPostHandler.mjs';
import { createConfiguredPlugEvolutionObserver } from '../../../../lib/evolution/plugEvolutionObserver.mjs';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(getPlugState(), { headers: { 'Cache-Control': 'no-store' } });
}

const post = createPlugPostHandler({
  jsonResponse: (body, options) => NextResponse.json(body, options),
  getPlugState,
  transitionPlugAssetLifecycle,
  updatePlugSnapshot,
  executeAcsmUnplug,
  closeGovernancePlugCycle,
  createGovernanceProfileForPlug,
  enqueuePpuOutboxEvent,
  buildPlugRequestedPpuEvent,
  sanitizeOutboxError,
  getEvolutionObserver: () => createConfiguredPlugEvolutionObserver(process.env),
  isEvolutionRequested: () => process.env.ACSM_EVOLUTION_OBSERVER_ENABLED != null &&
    process.env.ACSM_EVOLUTION_OBSERVER_ENABLED !== 'false',
  getActiveGovernanceProfile,
});

export async function POST(request) {
  return post(request);
}
