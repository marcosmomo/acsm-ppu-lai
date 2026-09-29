import { NextResponse } from 'next/server';
import { buildAcsmApiCatalog } from '../../../lib/acsm/apiCatalog.mjs';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(buildAcsmApiCatalog(), {
    headers: { 'Cache-Control': 'no-store' },
  });
}
