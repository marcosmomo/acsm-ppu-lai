import { ensureGovernanceProfile } from '../../../../../../services/governance/governanceStore';
import { jsonError, jsonOk, readJsonBody } from '../../../_response';

export async function POST(request, { params }) {
  try {
    const { cpsId } = await params;
    await readJsonBody(request);
    const result = ensureGovernanceProfile(cpsId);
    return jsonOk({ ...result, created: false }, 200);
  } catch (error) {
    return jsonError(error);
  }
}
