import type { PendingApproval } from "../chatTypes";
import type { ApprovalResponse } from "@nhicode/shared";
import { getToolDisplay } from "../utils/toolDisplay";
import { CATEGORY_LABEL } from "@nhicode/shared/types";

interface ApprovalModalProps {
  approval: PendingApproval;
  onDecision: (decision: ApprovalResponse["decision"]) => void;
  onClose: () => void;
}

const categoryLabel = (cat: string): string =>
  (CATEGORY_LABEL as Record<string, string>)[cat] ?? cat;

export function ApprovalModal({ approval, onDecision, onClose }: ApprovalModalProps) {
  const display = getToolDisplay(approval.toolName, approval.args);

  let formattedArgs = approval.args;
  try {
    formattedArgs = JSON.stringify(JSON.parse(approval.args), null, 2);
  } catch {
    // keep raw
  }

  const catLabel = categoryLabel(approval.category);

  return (
    <div className="modal-overlay">
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Approval Required</h2>
        <p style={{ color: "var(--text-secondary)", fontSize: 13, marginBottom: 4 }}>
          The agent wants to run:
        </p>

        <div className="approval-tool-name">
          {display.icon} {display.label}: {display.summary}
        </div>
        <div className="approval-category">
          Category: {catLabel}
        </div>
        <div className="approval-args">{formattedArgs}</div>

        <div className="approval-actions">
          <button className="btn btn-primary" onClick={() => onDecision("approve_once")}>
            Approve once
          </button>
          <button className="btn btn-secondary" onClick={() => onDecision("approve_session")}>
            Approve for session
          </button>
          <button className="btn btn-secondary" onClick={() => onDecision("approve_project")}>
            Always allow
          </button>
          <button className="btn btn-outline" onClick={() => onDecision("approve_category_session")}>
            Approve all {catLabel} (session)
          </button>
          <button className="btn btn-outline" onClick={() => onDecision("approve_category_project")}>
            Always allow {catLabel}
          </button>
          <button className="btn btn-danger" onClick={onClose}>
            Deny
          </button>
        </div>
      </div>
    </div>
  );
}
