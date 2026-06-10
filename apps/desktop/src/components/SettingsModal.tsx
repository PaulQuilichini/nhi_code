import { useEffect, useState } from "react";
import type { ApprovalRule } from "@nhicode/shared";
import { CATEGORY_LABEL } from "@nhicode/shared/types";
import {
  deleteApprovalRule,
  fetchApprovalRules,
  setApiKey,
  updateAgentConfig,
  type Config,
} from "../api";

interface SettingsModalProps {
  config: Config | null;
  providers: string[];
  activeProjectId?: string;
  onClose: () => void;
  onProvidersChange: (providers: string[]) => void;
  onConfigChange: (config: Config) => void;
}

export function SettingsModal({
  config,
  providers,
  activeProjectId,
  onClose,
  onProvidersChange,
  onConfigChange,
}: SettingsModalProps) {
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [approvalRules, setApprovalRules] = useState<ApprovalRule[]>([]);
  const [deletingRuleId, setDeletingRuleId] = useState<string | null>(null);
  const [maxTurns, setMaxTurns] = useState("0");
  const [savingAgentConfig, setSavingAgentConfig] = useState(false);

  useEffect(() => {
    void fetchApprovalRules(activeProjectId).then(setApprovalRules).catch(() => setApprovalRules([]));
  }, [activeProjectId]);

  useEffect(() => {
    setMaxTurns(String(config?.agents?.max_turns ?? 0));
  }, [config?.agents?.max_turns]);

  const handleSaveKey = async (providerId: string) => {
    const key = keys[providerId];
    if (!key) return;
    setSaving(providerId);
    try {
      const updated = await setApiKey(providerId, key);
      onProvidersChange(updated);
    } finally {
      setSaving(null);
    }
  };

  const handleDeleteApprovalRule = async (id: string) => {
    setDeletingRuleId(id);
    try {
      await deleteApprovalRule(id);
      setApprovalRules((prev) => prev.filter((rule) => rule.id !== id));
    } finally {
      setDeletingRuleId(null);
    }
  };

  const handleSaveAgentConfig = async () => {
    const parsed = Number(maxTurns);
    if (!Number.isFinite(parsed) || parsed < 0) return;
    setSavingAgentConfig(true);
    try {
      const updated = await updateAgentConfig({ max_turns: Math.floor(parsed) });
      onConfigChange(updated);
    } finally {
      setSavingAgentConfig(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Settings</h2>

        <div className="modal-section">
          <label>API Keys</label>
          {config?.providers.map((p) => (
            <div key={p.id} className="provider-key-row">
              <label>{p.id}</label>
              <input
                type="password"
                placeholder={p.api_key_env ?? "API key"}
                value={keys[p.id] ?? ""}
                onChange={(e) => setKeys((prev) => ({ ...prev, [p.id]: e.target.value }))}
              />
              <span
                className={`provider-status ${providers.includes(p.id) ? "connected" : "disconnected"}`}
              >
                {providers.includes(p.id) ? "connected" : "not set"}
              </span>
              <button
                className="btn btn-secondary"
                onClick={() => handleSaveKey(p.id)}
                disabled={!keys[p.id] || saving === p.id}
              >
                {saving === p.id ? "…" : "Save"}
              </button>
            </div>
          ))}
        </div>

        <div className="modal-section">
          <label>Agent turn cap</label>
          <div className="settings-inline-row">
            <input
              type="number"
              min="0"
              step="1"
              value={maxTurns}
              onChange={(e) => setMaxTurns(e.target.value)}
              aria-label="Agent turn cap"
            />
            <button
              className="btn btn-secondary"
              onClick={() => void handleSaveAgentConfig()}
              disabled={savingAgentConfig}
            >
              {savingAgentConfig ? "…" : "Save"}
            </button>
          </div>
          <div className="settings-help">
            0 means no total model/tool turn cap. Model request, idle, shell, approval, and cancel
            limits still apply.
          </div>
        </div>

        <div className="modal-section">
          <label>Persistent approvals</label>
          {approvalRules.length === 0 ? (
            <div className="settings-empty">No persistent approvals</div>
          ) : (
            <div className="approval-rule-list">
              {approvalRules.map((rule) => (
                <div key={rule.id} className="approval-rule-row">
                  <div className="approval-rule-main">
                    <span className="approval-rule-kind">{approvalRuleLabel(rule)}</span>
                    <span className="approval-rule-path">{rule.projectPath}</span>
                  </div>
                  <button
                    className="btn btn-outline"
                    disabled={deletingRuleId === rule.id}
                    onClick={() => void handleDeleteApprovalRule(rule.id)}
                  >
                    {deletingRuleId === rule.id ? "…" : "Delete"}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="modal-actions">
          <button className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

function approvalRuleLabel(rule: ApprovalRule): string {
  if (rule.kind === "shell_prefix") return `Shell prefix: ${rule.prefix ?? ""}`;
  if (rule.kind === "category") {
    return `Category: ${rule.category ? CATEGORY_LABEL[rule.category] : ""}`;
  }
  return `Tool: ${rule.toolName ?? ""}`;
}
