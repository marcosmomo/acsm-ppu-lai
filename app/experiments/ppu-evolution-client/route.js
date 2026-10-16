import { installPpuEvolutionSimulation } from '../../../lib/evolution/ppuEvolutionSimulationClient.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-static';

export function GET() {
  return new Response(`(${installPpuEvolutionSimulation.toString()})(document);`, {
    headers: {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'public, max-age=0, must-revalidate',
      'x-content-type-options': 'nosniff',
    },
  });
}
