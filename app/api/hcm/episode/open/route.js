import { openEpisode } from '../../../../../services/memory/cognitiveEpisodicMemoryService';
import { jsonError, jsonOk, readJsonBody } from '../../_response';

export async function POST(request) {
  try {
    const body = await readJsonBody(request);
    console.log('[HCM OPEN] request payload', body);
    const result = openEpisode(body);
    console.log('[HCM OPEN] response', {
      status: result.reused ? 200 : 201,
      reused: result.reused,
      episodeId: result.episode?.episodeId,
      episodeStatus: result.episode?.status,
      trigger: result.episode?.trigger,
      targetCps: result.episode?.targetCps,
    });
    return jsonOk(result, result.reused ? 200 : 201);
  } catch (error) {
    console.error('[HCM OPEN] error', {
      status: error.status || 500,
      message: error.message,
      details: error.details,
    });
    return jsonError(error);
  }
}
