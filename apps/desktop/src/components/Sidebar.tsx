import type { ThreadSummary } from "@nhicode/shared";

interface SidebarProps {
  threads: ThreadSummary[];
  activeThreadId: string | null;
  onSelectThread: (id: string) => void;
  onNewThread: () => void;
  onOpenSettings: () => void;
  providers: string[];
}

export function Sidebar({
  threads,
  activeThreadId,
  onSelectThread,
  onNewThread,
  onOpenSettings,
  providers,
}: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="sidebar-logo">
          NHI <span>Code</span>
        </div>
        <div className="sidebar-actions">
          <button className="icon-btn" onClick={onOpenSettings} title="Settings">
            ⚙
          </button>
        </div>
      </div>

      <button className="new-thread-btn" onClick={onNewThread}>
        + New Thread
      </button>

      <div className="thread-list">
        {threads.map((thread) => (
          <div
            key={thread.id}
            className={`thread-item ${thread.id === activeThreadId ? "active" : ""}`}
            onClick={() => onSelectThread(thread.id)}
          >
            <div className="thread-title">{thread.title}</div>
            <div className="thread-meta">
              <span className={`status-dot ${thread.status}`} />
              <span>{thread.mode}</span>
              <span>{thread.model.split("-").slice(-2).join("-")}</span>
            </div>
          </div>
        ))}
        {threads.length === 0 && (
          <div style={{ padding: "16px", color: "var(--text-muted)", fontSize: 13, textAlign: "center" }}>
            No threads yet
          </div>
        )}
      </div>

      <div className="sidebar-footer">
        {providers.length > 0
          ? `${providers.length} provider${providers.length > 1 ? "s" : ""} connected`
          : "No providers — open Settings"}
      </div>
    </aside>
  );
}
