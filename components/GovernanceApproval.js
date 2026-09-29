'use client';

import React from 'react';

const formatAction = (action) => String(action || '').replace(/_/g, ' ');

export default function GovernanceApproval({ actions = [], onApprove, onReject }) {
  const visibleActions = actions.slice(0, 5);
  if (!visibleActions.length) return null;

  return (
    <div className="governance-approval-panel">
      <h3>Governance Approval Required</h3>
      <div className="governance-approval-list">
        {visibleActions.map((action) => {
          const pending = action?.status === 'PENDING_HUMAN_APPROVAL';
          const executionStatus =
            action?.executionStatus || (action?.status === 'REJECTED' ? 'NOT_EXECUTED' : 'NOT_EXECUTED');
          return (
          <article key={action.actionId} className="governance-approval-item">
            <div className="governance-approval-main">
              <strong>{String(action.cpsId || '').toUpperCase()}</strong>
              <span>Recommendation: {formatAction(action.action)} by {action.requestedValue}{action.unit || '%'}</span>
              <span>Autonomous limit: {action.autonomousLimit}{action.unit || '%'}</span>
              <span>Requested: {action.requestedValue}{action.unit || '%'}</span>
              <span>Governance: {String(action.status || action.governanceDecision || '').replace(/_/g, ' ')}</span>
              <span>Execution: {String(executionStatus).replace(/_/g, ' ')}</span>
            </div>
            {pending && (
              <div className="governance-approval-actions">
                <button
                  type="button"
                  className="start-ops-btn"
                  onClick={() => onApprove?.(action.actionId)}
                >
                  Approve Action
                </button>
                <button
                  type="button"
                  className="exit-btn"
                  onClick={() => onReject?.(action.actionId)}
                >
                  Reject Action
                </button>
              </div>
            )}
          </article>
        );
        })}
      </div>
    </div>
  );
}
