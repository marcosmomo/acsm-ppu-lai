import { curateKnowledgeItem } from '../../../../../../services/memory/cognitiveEpisodicMemoryService';
import { jsonError, jsonOk, readJsonBody } from '../../../_response';

export async function POST(request, { params }) {
  try {
    const { knowledgeId } = await params;
    const body = await readJsonBody(request);
    return jsonOk(curateKnowledgeItem(knowledgeId, body));
  } catch (error) {
    return jsonError(error);
  }
}
