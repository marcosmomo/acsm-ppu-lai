import {
  createGovernanceProfileForPlug,
  ensureGovernanceProfile,
  getGovernanceProfile,
  updateGovernanceProfile,
} from '../../../../../services/governance/governanceStore';
import { jsonError, jsonOk, readJsonBody } from '../../_response';

export async function GET(_request, { params }) {
  try {
    const { cpsId } = await params;
    return jsonOk(getGovernanceProfile(cpsId));
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request, { params }) {
  try {
    const { cpsId } = await params;
    const body = await readJsonBody(request);
    if (body?.updatePolicies) {
      return jsonOk(
        updateGovernanceProfile(
          cpsId,
          body?.policies || {},
          body?.updatedBy || 'human-operator'
        )
      );
    }
    if (body?.createForPlug) {
      return jsonOk(createGovernanceProfileForPlug(cpsId, body?.cps || body), 201);
    }
    return jsonOk(ensureGovernanceProfile(cpsId, body?.cps || body), 201);
  } catch (error) {
    return jsonError(error);
  }
}
