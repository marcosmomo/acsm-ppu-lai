import { renderE1OfflineHtml } from '../../../lib/evolution/e1OfflineDashboard.mjs';
import { renderAvm3VersionManagerHtml } from '../../../lib/evolution/avm3VersionManagerDashboard.mjs';
import { renderAvm5PpuHistoryHtml } from '../../../lib/evolution/avm5PpuHistoryDashboard.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-static';

export function GET() {
  return new Response(renderAvm5PpuHistoryHtml(renderAvm3VersionManagerHtml(renderE1OfflineHtml())), {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=0, must-revalidate',
      'x-content-type-options': 'nosniff',
    },
  });
}
