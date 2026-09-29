import { rejectGovernanceProfile } from '../../../../../../services/governance/governanceStore';
import { jsonError, jsonOk, readJsonBody } from '../../../_response';

export async function POST(request, { params }) {
  try {
    const { cpsId } = await params;
    const body = await readJsonBody(request);
    return jsonOk(rejectGovernanceProfile(cpsId, body?.rejectedBy || 'human-operator'));
  } catch (error) {
    return jsonError(error);
  }
}
