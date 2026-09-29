import {
  checkGovernance,
  listPendingGovernanceActions,
} from '../../../../services/governance/governanceStore';
import { jsonError, jsonOk, readJsonBody } from '../_response';

export async function POST(request) {
  try {
    const body = await readJsonBody(request);
    const result = await checkGovernance(body);
    return jsonOk({
      ...result,
      pendingActions: listPendingGovernanceActions(),
    });
  } catch (error) {
    return jsonError(error);
  }
}
