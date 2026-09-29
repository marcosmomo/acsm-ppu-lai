import { NextResponse } from 'next/server';
import { getPlugState, updatePlugSnapshot } from '../../../../lib/acsm/plugStore.mjs';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(getPlugState(), { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request) {
  try {
    return NextResponse.json(updatePlugSnapshot(await request.json()), {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return NextResponse.json({ error: error?.message || 'Invalid Plug snapshot.' }, { status: 400 });
  }
}
