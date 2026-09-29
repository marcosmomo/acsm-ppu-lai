import { listEpisodes } from '../../../../services/memory/cognitiveEpisodicMemoryService';
import { jsonError, jsonOk } from '../_response';

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    return jsonOk({ episodes: listEpisodes({ limit: searchParams.get('limit') }) });
  } catch (error) {
    return jsonError(error);
  }
}
