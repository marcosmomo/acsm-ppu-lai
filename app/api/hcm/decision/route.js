import { registerDecision } from '../../../../services/memory/cognitiveEpisodicMemoryService';
import { jsonError, jsonOk, readJsonBody } from '../_response';

export async function POST(request) {
  try {
    const body = await readJsonBody(request);
    console.log('[HCM DECISION] request payload', body);
    const result = registerDecision(body);
    console.log('[HCM DECISION] response', {
      status: 201,
      decisionId: result.decision?.decisionId,
      episodeId: result.decision?.episodeId,
      targetCps: result.decision?.targetCps,
      action: result.decision?.action,
    });
    return jsonOk(result, 201);
  } catch (error) {
    console.error('[HCM DECISION] error', {
      status: error.status || 500,
      message: error.message,
      details: error.details,
    });
    return jsonError(error);
  }
}
