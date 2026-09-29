import { NextResponse } from 'next/server';
import { getPlayState, updatePlaySnapshot } from '../../../../lib/acsm/playStore.mjs';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(getPlayState(), { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request) {
  try {
    const snapshot = await request.json();
    const play = updatePlaySnapshot(snapshot);
    console.info(
      `[ACSM PLAY] activeCPS=${play.activeCPS.count} globalOEE=${play.globalOEE.evidenceStatus} ` +
      `learning=${play.learning.state} recommendation=${play.recommendation.state}`
    );
    return NextResponse.json(play, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({ error: error?.message || 'Invalid Play snapshot.' }, { status: 400 });
  }
}
