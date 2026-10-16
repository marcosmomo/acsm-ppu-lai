import { renderPpuEvolutionSimulationHtml } from '../../../lib/evolution/ppuEvolutionSimulationDashboard.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-static';

export function GET() {
  return new Response(renderPpuEvolutionSimulationHtml(), {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=0, must-revalidate',
      'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'x-content-type-options': 'nosniff',
    },
  });
}
