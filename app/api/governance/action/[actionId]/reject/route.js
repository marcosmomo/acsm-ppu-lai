import {
  decideGovernanceAction,
} from '../../../../../../services/governance/governanceStore';
import { GOVERNANCE_ACTION_STATUS } from '../../../../../../lib/governance/policies';
import { jsonError, jsonOk, readJsonBody } from '../../../_response';

export async function POST(request, { params }) {
  try {
    const { actionId } = await params;
    const body = await readJsonBody(request);
    return jsonOk(
      await decideGovernanceAction(
        actionId,
        GOVERNANCE_ACTION_STATUS.REJECTED,
        body?.rejectedBy || body?.decidedBy || 'human-operator'
      )
    );
  } catch (error) {
    return jsonError(error);
  }
}
