import { listEpisodes } from '../../../../../services/memory/cognitiveEpisodicMemoryService';
import { jsonError, jsonOk } from '../../_response';

export async function GET() {
  try {
    return jsonOk({ episodes: listEpisodes({ status: 'open' }) });
  } catch (error) {
    return jsonError(error);
  }
}
