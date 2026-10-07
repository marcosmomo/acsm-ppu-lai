import { getPlugState } from '../../../../../../lib/acsm/plugStore.mjs';
import { evaluateLifecyclePlayGate } from '../../../../../../lib/governance/lifecycleGate.mjs';
import { getGovernanceProfile } from '../../../../../../services/governance/governanceStore';
import { jsonOk } from '../../../_response';

export async function POST(_request, { params }) {
  const { cpsId } = await params;
  const { profile } = getGovernanceProfile(cpsId);
  const result = evaluateLifecyclePlayGate({ cpsId, profile, plugState: getPlugState() });
  return jsonOk(result, result.status);
}
