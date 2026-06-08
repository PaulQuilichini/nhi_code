import { useState } from "react";
import type { Project, ThreadSummary } from "@nhicode/shared";
import type { Theme } from "../theme";

interface SidebarProps {
  projects: Project[];
  threads: ThreadSummary[];
  activeProjectId: string | null;
  activeThreadId: string | null;
  collapsedProjects: Set<string>;
  theme: Theme;
  onToggleTheme: () => void;
  onSelectThread: (id: string) => void;
  onNewThread: (projectId: string) => void;
  onAddProject: (path: string, name?: string) => Promise<void>;
  onDeleteProject: (projectId: string) => void;
  onRenameProject: (projectId: string, name: string) => void;
  onToggleProjectCollapsed: (projectId: string) => void;
  onOpenSettings: () => void;
  providers: string[];
}

export function Sidebar({
  projects,
  threads,
  activeProjectId,
  activeThreadId,
  collapsedProjects,
  theme,
  onToggleTheme,
  onSelectThread,
  onNewThread,
  onAddProject,
  onDeleteProject,
  onRenameProject,
  onToggleProjectCollapsed,
  onOpenSettings,
  providers,
}: SidebarProps) {
  const [showAddProject, setShowAddProject] = useState(false);
  const [newProjectPath, setNewProjectPath] = useState("");
  const [newProjectName, setNewProjectName] = useState("");
  const [addingProject, setAddingProject] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const threadsByProject = new Map<string, ThreadSummary[]>();
  for (const thread of threads) {
    if (!thread.projectId) continue;
    const list = threadsByProject.get(thread.projectId) ?? [];
    list.push(thread);
    threadsByProject.set(thread.projectId, list);
  }

  const handleAddProject = async () => {
    const path = newProjectPath.trim();
    if (!path) return;
    setAddingProject(true);
    try {
      await onAddProject(path, newProjectName.trim() || undefined);
      setNewProjectPath("");
      setNewProjectName("");
      setShowAddProject(false);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setAddingProject(false);
    }
  };

  const startRename = (project: Project) => {
    setRenamingId(project.id);
    setRenameValue(project.name);
  };

  const commitRename = (projectId: string) => {
    const name = renameValue.trim();
    if (name) onRenameProject(projectId, name);
    setRenamingId(null);
    setRenameValue("");
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="sidebar-logo">
          NHI <span>Code</span>
        </div>
        <div className="sidebar-actions">
          <button
            className="icon-btn"
            onClick={onToggleTheme}
            title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          >
            {theme === "dark" ? "☀" : "☾"}
          </button>
          <button className="icon-btn" onClick={onOpenSettings} title="Settings">
            ⚙
          </button>
        </div>
      </div>

      <div className="projects-section">
        <div className="projects-section-header">
          <span>Projects</span>
          <button
            className="icon-btn projects-add-btn"
            onClick={() => setShowAddProject((v) => !v)}
            title="Add project"
          >
            +
          </button>
        </div>

        {showAddProject && (
          <div className="add-project-form">
            <input
              type="text"
              value={newProjectPath}
              onChange={(e) => setNewProjectPath(e.target.value)}
              placeholder="C:\Users\You\Projects\my-app"
              onKeyDown={(e) => e.key === "Enter" && void handleAddProject()}
            />
            <input
              type="text"
              value={newProjectName}
              onChange={(e) => setNewProjectName(e.target.value)}
              placeholder="Display name (optional)"
              onKeyDown={(e) => e.key === "Enter" && void handleAddProject()}
            />
            <div className="add-project-actions">
              <button
                className="btn btn-primary btn-sm"
                onClick={() => void handleAddProject()}
                disabled={!newProjectPath.trim() || addingProject}
              >
                {addingProject ? "…" : "Add"}
              </button>
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => setShowAddProject(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="thread-list">
        {projects.map((project) => {
          const projectThreads = threadsByProject.get(project.id) ?? [];
          const collapsed = collapsedProjects.has(project.id);
          const isActiveProject = project.id === activeProjectId;

          return (
            <div
              key={project.id}
              className={`project-group ${isActiveProject ? "active-project" : ""}`}
            >
              <div className="project-header">
                <button
                  className="project-collapse-btn"
                  onClick={() => onToggleProjectCollapsed(project.id)}
                  title={collapsed ? "Expand" : "Collapse"}
                >
                  {collapsed ? "▸" : "▾"}
                </button>
                <span className="project-icon" title={project.path}>
                  📁
                </span>
                {renamingId === project.id ? (
                  <input
                    className="project-rename-input"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={() => commitRename(project.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename(project.id);
                      if (e.key === "Escape") setRenamingId(null);
                    }}
                    autoFocus
                  />
                ) : (
                  <span
                    className="project-name"
                    title={project.path}
                    onDoubleClick={() => startRename(project)}
                  >
                    {project.name}
                  </span>
                )}
                <div className="project-actions">
                  <button
                    className="icon-btn project-action-btn"
                    onClick={() => onNewThread(project.id)}
                    title="New chat"
                  >
                    +
                  </button>
                  <button
                    className="icon-btn project-action-btn"
                    onClick={() => startRename(project)}
                    title="Rename"
                  >
                    ✎
                  </button>
                  <button
                    className="icon-btn project-action-btn project-delete-btn"
                    onClick={() => {
                      if (
                        confirm(
                          `Delete project "${project.name}" and all its chats? This cannot be undone.`,
                        )
                      ) {
                        onDeleteProject(project.id);
                      }
                    }}
                    title="Delete project"
                  >
                    ×
                  </button>
                </div>
              </div>

              {!collapsed && (
                <div className="project-threads">
                  {projectThreads.map((thread) => (
                    <div
                      key={thread.id}
                      className={`thread-item ${thread.id === activeThreadId ? "active" : ""}`}
                      onClick={() => onSelectThread(thread.id)}
                    >
                      <div className="thread-title">{thread.title}</div>
                      <div className="thread-meta">
                        <span className={`status-dot ${thread.status}`} />
                        <span>{thread.mode}</span>
                      </div>
                    </div>
                  ))}
                  {projectThreads.length === 0 && (
                    <button
                      className="project-new-chat-btn"
                      onClick={() => onNewThread(project.id)}
                    >
                      + New chat
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {projects.length === 0 && (
          <div className="sidebar-empty">
            Add a project folder to start chatting
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
