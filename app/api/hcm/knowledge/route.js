import {
  getHcmRepositoryDiagnostics,
  listKnowledgeItems,
  registerKnowledgeItem,
} from '../../../../services/memory/cognitiveEpisodicMemoryService.js';
import { jsonError, jsonOk, readJsonBody } from '../_response.js';

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    return jsonOk({
      repository: getHcmRepositoryDiagnostics(),
      knowledgeItems: listKnowledgeItems({
        cpsId: searchParams.get('cpsId'),
        source: searchParams.get('source'),
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
    return jsonOk({
      ...result,
      persisted: true,
      repository: getHcmRepositoryDiagnostics(),
    }, result.reused ? 200 : 201);
  } catch (error) {
    return jsonError(error);
  }
}
