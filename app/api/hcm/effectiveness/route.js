import {
  listEffectiveness,
  registerEffectiveness,
} from '../../../../services/memory/cognitiveEpisodicMemoryService';
import { jsonError, jsonOk, readJsonBody } from '../_response';

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    return jsonOk({ effectiveness: listEffectiveness({ limit: searchParams.get('limit') }) });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request) {
  try {
    const body = await readJsonBody(request);
    console.log('[HCM EFFECTIVENESS] request payload', body);
    const result = registerEffectiveness(body);
    console.log('[HCM EFFECTIVENESS] response', {
      status: 201,
      effectivenessId: result.effectiveness?.effectivenessId,
      episodeId: result.effectiveness?.episodeId,
      result: result.effectiveness?.result,
      globalOEEGain: result.effectiveness?.globalOEEGain,
    });
    return jsonOk(result, 201);
  } catch (error) {
    console.error('[HCM EFFECTIVENESS] error', {
      status: error.status || 500,
      message: error.message,
      details: error.details,
    });
    return jsonError(error);
  }
}
