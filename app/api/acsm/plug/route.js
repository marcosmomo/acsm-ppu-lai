import { NextResponse } from 'next/server';
import {
  getPlugState,
  transitionPlugAssetLifecycle,
  updatePlugSnapshot,
} from '../../../../lib/acsm/plugStore.mjs';
import { executeAcsmUnplug } from '../../../../lib/acsm/unplugLifecycle.mjs';
import { createGovernanceProfileForPlug } from '../../../../services/governance/governanceStore.js';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(getPlugState(), { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request) {
  try {
    const snapshot = await request.json();
    if (snapshot?.lifecycleTransition?.phase) {
      const { cpsId, phase, timestamp, plugEventId } = snapshot.lifecycleTransition;
      const normalizedPhase = String(phase).toLowerCase();
      if (normalizedPhase === 'plug') {
        if (!cpsId || !plugEventId) {
          return NextResponse.json({ error: 'cpsId and plugEventId are required for Plug.' }, { status: 400 });
        }

        let current = getPlugState();
        let asset = current.assets.find((item) =>
          [item?.cps?.cpsId, item?.cps?.id, item?.interfaces?.baseTopic]
            .some((value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '') === String(cpsId).toLowerCase().replace(/[^a-z0-9]/g, ''))
        );
        if (!asset && snapshot.asset?.aas?.id) {
          current = updatePlugSnapshot({
            assets: [...current.assets, snapshot.asset],
          });
          asset = current.assets.find((item) =>
            [item?.cps?.cpsId, item?.cps?.id, item?.interfaces?.baseTopic]
              .some((value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '') === String(cpsId).toLowerCase().replace(/[^a-z0-9]/g, ''))
          );
        }
        if (!asset?.aas?.id) {
          return NextResponse.json({ ok: false, cpsId, reason: 'CPS_NOT_REGISTERED_OR_AAS_MISSING' }, { status: 404 });
        }

        const governance = createGovernanceProfileForPlug(
          cpsId,
          asset.cps || { id: cpsId },
          { plugEventId }
        );
        if (
          !governance.activeProfile ||
          governance.activeProfile.status !== 'PENDING_APPROVAL'
        ) {
          return NextResponse.json({ ok: false, cpsId, reason: 'ACTIVE_PENDING_PROFILE_NOT_CREATED' }, { status: 409 });
        }
        const transition = transitionPlugAssetLifecycle(cpsId, 'plug', timestamp);
        if (!transition.ok) {
          return NextResponse.json({ ok: false, cpsId, reason: transition.reason }, { status: 404 });
        }
        return NextResponse.json({
          ok: true,
          cpsId,
          lifecyclePhase: 'plug',
          activeProfile: governance.activeProfile,
          state: transition.state,
        }, { headers: { 'Cache-Control': 'no-store' } });
      }

      if (!['unplug', 'unplugged'].includes(normalizedPhase)) {
        return NextResponse.json({ error: 'Unsupported lifecycle transition.' }, { status: 400 });
      }
      const result = executeAcsmUnplug(cpsId, timestamp);
      return NextResponse.json(result, {
        status: result.ok ? 200 : 404,
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    for (const asset of Array.isArray(snapshot?.assets) ? snapshot.assets : []) {
      const cpsId = asset?.cps?.cpsId || asset?.cps?.id || asset?.interfaces?.baseTopic;
      const lifecyclePhase = String(
        asset?.cps?.lifecyclePhase || asset?.lifecyclePhase || ''
      ).trim().toLowerCase();
      if (cpsId && (lifecyclePhase === 'unplug' || lifecyclePhase === 'unplugged')) {
        closeGovernancePlugCycle(cpsId);
      }
    }
    return NextResponse.json(updatePlugSnapshot(snapshot), {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return NextResponse.json({ error: error?.message || 'Invalid Plug snapshot.' }, { status: 400 });
  }
}
