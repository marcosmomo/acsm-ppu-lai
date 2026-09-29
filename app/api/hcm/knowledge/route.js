import {
  listKnowledgeItems,
  registerKnowledgeItem,
} from '../../../../services/memory/cognitiveEpisodicMemoryService';
import { jsonError, jsonOk, readJsonBody } from '../_response';

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    return jsonOk({
      knowledgeItems: listKnowledgeItems({
        cpsId: searchParams.get('cpsId'),
        limit: searchParams.get('limit'),
      }),
    });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request) {
  try {
    const body = await readJsonBody(request);
    const result = registerKnowledgeItem(body);
    return jsonOk(result, result.reused ? 200 : 201);
  } catch (error) {
    return jsonError(error);
  }
}
