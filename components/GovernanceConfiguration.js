'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { sanitizeTextEncoding } from '../lib/text/sanitizeTextEncoding';

const txt = (value, fallback = '-') => sanitizeTextEncoding(value, { fallback });

const formatStatus = (status) =>
  txt(status, 'NOT_DEFINED').replace(/_/g, ' ');

export default function GovernanceConfiguration({
  cps,
  onApprove,
  onReject,
  onSave,
  onRefresh,
  onReview,
  onClose,
  isOpen = false,
  isLoading = false,
  errorMessage = '',
}) {
  const profile = cps?.governanceProfile || null;
  const actions = useMemo(
    () =>
      Array.isArray(profile?.policies?.governableActions)
        ? profile.policies.governableActions
        : [],
    [profile?.policies?.governableActions]
  );
  const isPendingApproval = profile?.status === 'PENDING_APPROVAL';
  const isApproved = profile?.status === 'APPROVED';
  const [editableActions, setEditableActions] = useState([]);
  const [localError, setLocalError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');

  useEffect(() => {
    setEditableActions(
      actions.map((policy) => ({
        action: policy.action,
        autonomousLimit: String(policy.autonomousLimit ?? ''),
        humanApprovalLimit: String(policy.humanApprovalLimit ?? ''),
      }))
    );
    setLocalError('');
    setSuccessMessage('');
  }, [actions, profile?.profileId, profile?.profileVersion, profile?.updatedAt, profile?.status]);

  const conceptualPolicies = useMemo(
    () =>
      Object.entries(profile?.policies || {}).filter(
        ([key]) => key !== 'governableActions'
      ),
    [profile?.policies]
  );

  const handleLimitChange = (action, field, value) => {
    setLocalError('');
    setSuccessMessage('');
    setEditableActions((prev) =>
      prev.map((item) => (item.action === action ? { ...item, [field]: value } : item))
    );
  };

  const validatePolicies = () => {
    for (const policy of editableActions) {
      const autonomousLimit = Number(policy.autonomousLimit);
      const humanApprovalLimit = Number(policy.humanApprovalLimit);

      if (policy.autonomousLimit === '' || !Number.isFinite(autonomousLimit) || autonomousLimit < 0) {
        return 'Autonomous limit must be a number greater than or equal to 0.';
      }

      if (
        policy.humanApprovalLimit === '' ||
        !Number.isFinite(humanApprovalLimit) ||
        humanApprovalLimit <= autonomousLimit
      ) {
        return 'Human approval limit must be greater than autonomous limit.';
      }
    }

    return '';
  };

  const handleSave = async () => {
    const validationError = validatePolicies();
    if (validationError) {
      setLocalError(validationError);
      setSuccessMessage('');
      return;
    }

    try {
      const savedProfile = await onSave?.(cps?.id, {
        governableActions: editableActions.map((policy) => ({
          action: policy.action,
          autonomousLimit: Number(policy.autonomousLimit),
          humanApprovalLimit: Number(policy.humanApprovalLimit),
        })),
      });
      if (!savedProfile) throw new Error('Unable to save Governance Profile changes.');
      setLocalError('');
      setSuccessMessage('Governance Profile changes saved. Status remains PENDING APPROVAL.');
    } catch (error) {
      setLocalError(error?.message || 'Unable to save Governance Profile changes.');
      setSuccessMessage('');
    }
  };

  const handleReview = () => {
    if (onReview) {
      onReview(cps);
      return;
    }
    onRefresh?.(cps?.id);
  };

  return (
    <div className="governance-config">
      <div className="governance-config-header">
        <div>
          <div className="plug-asset-box-title">Governance Profile</div>
          <div className="governance-config-subtitle">
            {txt(profile?.profileId)} | v{txt(profile?.profileVersion, '1')}
          </div>
        </div>
        <span className={`governance-status governance-status-${String(profile?.status || '').toLowerCase()}`}>
          {formatStatus(profile?.status)}
        </span>
      </div>

      <div className="governance-config-grid">
        <div>
          <span>CPS</span>
          <strong>{txt(cps?.id)}</strong>
        </div>
        <div>
          <span>Asset</span>
          <strong>{txt(cps?.nome || cps?.assetName || cps?.name)}</strong>
        </div>
        <div>
          <span>Asset Type</span>
          <strong>{txt(cps?.assetType || profile?.capability)}</strong>
        </div>
        <div>
          <span>Capability</span>
          <strong>{txt(profile?.capability || cps?.assetType)}</strong>
        </div>
        <div>
          <span>Template</span>
          <strong>{txt(profile?.template)}</strong>
        </div>
        {profile?.previousProfileVersion ? (
          <div>
            <span>Previous Governance Version</span>
            <strong>{txt(profile.previousProfileVersion)}</strong>
          </div>
        ) : null}
      </div>

      {isOpen ? (
        <>
          {isLoading ? <div className="plug-empty-log">Loading Governance Profile...</div> : null}
          {errorMessage ? (
            <div className="plug-feedback plug-feedback-error" role="alert">
              {txt(errorMessage)}
            </div>
          ) : null}
          {localError ? (
            <div className="plug-feedback plug-feedback-error" role="alert">
              {txt(localError)}
            </div>
          ) : null}
          {successMessage ? (
            <div className="plug-feedback plug-feedback-success" role="status">
              {txt(successMessage)}
            </div>
          ) : null}
          {isApproved ? (
            <div className="plug-feedback plug-feedback-success" role="status">
              Governance Profile is approved and read-only.
            </div>
          ) : null}

          <div className="governance-policy-list">
            {actions.length ? (
              actions.map((policy) => {
                const draft = editableActions.find((item) => item.action === policy.action) || {};
                return (
                  <div key={policy.action} className="governance-policy-row governance-policy-editor-row">
                    <strong>{txt(policy.action)}</strong>
                    <div className="governance-policy-editor">
                      <label>
                        <span>Autonomous Limit</span>
                        <input
                          type="number"
                          min="0"
                          step="0.1"
                          value={draft.autonomousLimit ?? ''}
                          onChange={(event) =>
                            handleLimitChange(policy.action, 'autonomousLimit', event.target.value)
                          }
                          disabled={!isPendingApproval || isLoading}
                        />
                        <em>%</em>
                      </label>
                      <label>
                        <span>Human Approval Limit</span>
                        <input
                          type="number"
                          min="0"
                          step="0.1"
                          value={draft.humanApprovalLimit ?? ''}
                          onChange={(event) =>
                            handleLimitChange(policy.action, 'humanApprovalLimit', event.target.value)
                          }
                          disabled={!isPendingApproval || isLoading}
                        />
                        <em>%</em>
                      </label>
                      <span>Decision above Human Approval Limit: DENY</span>
                    </div>
                  </div>
                );
              })
            ) : (
              <div className="governance-policy-row">
                <strong>No governable action</strong>
                <span>Profile is not defined for this CPS.</span>
              </div>
            )}
            {conceptualPolicies.map(([key, value]) => (
              <div key={key} className="governance-policy-row">
                <strong>{txt(key)}</strong>
                <span>{txt(value)}</span>
              </div>
            ))}
          </div>
        </>
      ) : null}

      <div className="governance-config-actions">
        <button type="button" className="restart-btn" onClick={handleReview} disabled={isLoading}>
          Review Governance
        </button>
        {isOpen ? (
          <>
            {isPendingApproval ? (
              <button
                type="button"
                className="restart-btn"
                onClick={handleSave}
                disabled={isLoading || !actions.length}
              >
                Save Changes
              </button>
            ) : null}
            <button
              type="button"
              className="start-ops-btn"
              onClick={() => onApprove?.(cps?.id)}
              disabled={isLoading || profile?.status === 'APPROVED'}
            >
              Approve Governance
            </button>
            <button
              type="button"
              className="exit-btn"
              onClick={() => onReject?.(cps?.id)}
              disabled={isLoading || profile?.status === 'REJECTED'}
            >
              Reject Governance
            </button>
            <button type="button" className="modal-cancel-btn" onClick={onClose}>
              Close
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}
