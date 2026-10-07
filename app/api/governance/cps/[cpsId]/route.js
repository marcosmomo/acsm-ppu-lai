import {
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
    // Legacy POST remains read-only; only an explicit lifecycle Plug event
    // in /api/acsm/plug may create a governance profile.
    return jsonOk(ensureGovernanceProfile(cpsId), 200);
  } catch (error) {
    return jsonError(error);
  }
}
