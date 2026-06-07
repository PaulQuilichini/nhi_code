import { useState } from "react";
import { setApiKey, type Config } from "../api";

interface SettingsModalProps {
  cwd: string;
  onCwdChange: (cwd: string) => void;
  config: Config | null;
  providers: string[];
  onClose: () => void;
  onProvidersChange: (providers: string[]) => void;
}

export function SettingsModal({
  cwd,
  onCwdChange,
  config,
  providers,
  onClose,
  onProvidersChange,
}: SettingsModalProps) {
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);

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

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Settings</h2>

        <div className="modal-section">
          <label>Project Directory</label>
          <input
            type="text"
            value={cwd}
            onChange={(e) => onCwdChange(e.target.value)}
            placeholder="C:\Users\You\Projects\my-app"
          />
        </div>

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

        <div className="modal-actions">
          <button className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
