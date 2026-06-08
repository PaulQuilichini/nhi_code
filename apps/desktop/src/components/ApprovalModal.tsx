import { useEffect, useState } from "react";
import type { PendingApproval } from "../chatTypes";
import type { ApprovalResponse } from "@nhicode/shared";
import { getToolDisplay } from "../utils/toolDisplay";
import { CATEGORY_LABEL } from "@nhicode/shared/types";
import { suggestShellPrefix } from "@nhicode/shared/shell";

interface ApprovalModalProps {
  approval: PendingApproval;
  onDecision: (decision: ApprovalResponse["decision"], shellPrefix?: string) => void;
  onClose: () => void;
}

const categoryLabel = (cat: string): string =>
  (CATEGORY_LABEL as Record<string, string>)[cat] ?? cat;

export function ApprovalModal({ approval, onDecision, onClose }: ApprovalModalProps) {
  const display = getToolDisplay(approval.toolName, approval.args);
  const isShell = approval.toolName === "shell";
  const [shellPrefix, setShellPrefix] = useState(() => approval.suggestedShellPrefix ?? shellPrefixFromArgs(approval.args));

  useEffect(() => {
    setShellPrefix(approval.suggestedShellPrefix ?? shellPrefixFromArgs(approval.args));
  }, [approval]);

  let formattedArgs = approval.args;
  try {
    formattedArgs = JSON.stringify(JSON.parse(approval.args), null, 2);
  } catch {
    // keep raw
  }

  const catLabel = categoryLabel(approval.category);
  const canPersistShellPrefix = isShell && shellPrefix.trim().length > 0;

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

        {isShell && (
          <label className="approval-prefix">
            <span>Always allow commands starting with</span>
            <input
              value={shellPrefix}
              onChange={(e) => setShellPrefix(e.target.value)}
              spellCheck={false}
            />
          </label>
        )}

        <div className="approval-actions">
          <button className="btn btn-primary" onClick={() => onDecision("approve_once")}>
            Approve once
          </button>
          <button className="btn btn-secondary" onClick={() => onDecision("approve_session")}>
            Approve for session
          </button>
          {isShell ? (
            <button
              className="btn btn-secondary"
              disabled={!canPersistShellPrefix}
              onClick={() => onDecision("approve_shell_prefix_project", shellPrefix.trim())}
            >
              Always allow prefix
            </button>
          ) : (
            <>
              <button className="btn btn-secondary" onClick={() => onDecision("approve_project")}>
                Always allow
              </button>
              <button className="btn btn-outline" onClick={() => onDecision("approve_category_session")}>
                Approve all {catLabel} (session)
              </button>
              <button className="btn btn-outline" onClick={() => onDecision("approve_category_project")}>
                Always allow {catLabel}
              </button>
            </>
          )}
          <button className="btn btn-danger" onClick={onClose}>
            Deny
          </button>
        </div>
      </div>
    </div>
  );
}

function shellPrefixFromArgs(args: string): string {
  try {
    const parsed = JSON.parse(args) as { command?: unknown };
    return typeof parsed.command === "string" ? suggestShellPrefix(parsed.command) : "";
  } catch {
    return "";
  }
}
