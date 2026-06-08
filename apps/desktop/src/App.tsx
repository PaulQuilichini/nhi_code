import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import type { SessionEvent, SessionStatus, Project, ThreadSummary, ApprovalResponse } from "@nhicode/shared";
import {
  fetchThreads,
  fetchThreadMessages,
  fetchBootstrap,
  createThread,
  createProject,
  updateProject,
  deleteProject,
  sendMessage,
  setThreadMode,
  cancelThread,
  respondToApproval,
  connectWebSocket,
  fetchHealth,
  type Config,
} from "./api";
import { Sidebar } from "./components/Sidebar";
import { ChatPanel } from "./components/ChatPanel";
import { SettingsModal } from "./components/SettingsModal";
import { ApprovalModal } from "./components/ApprovalModal";
import { storedMessagesToChat } from "./utils/storedMessages";
import { getToolDisplay } from "./utils/toolDisplay";
import type { ChatMessage, PendingApproval, StatusNotice, SubAgentMessage, ThinkingMessage } from "./chatTypes";
import {
  applySubAgentEvent,
  clearSubAgentBuffers,
  finalizeSubAgentItems,
  parseSubAgentArgs,
  SUBAGENT_PROFILE_LABEL,
} from "./utils/subagentStream";
import { applyStreamDelta, emptyStreamBuffers } from "./utils/streamDelta";
import { applyTheme, getStoredTheme, type Theme } from "./theme";
import "./styles/app.css";

export type {
  UserMessage,
  AssistantMessage,
  ThinkingMessage,
  ToolMessage,
  SubAgentMessage,
  ChatMessage,
  PendingApproval,
  StatusNotice,
} from "./chatTypes";

type ConnectionStatus = "connecting" | "connected" | "disconnected" | "reconnecting";

const RECONNECT_DELAY_MS = 1500;
const MAX_RECONNECT_ATTEMPTS = 5;
const STALE_ACTIVITY_MS = 45_000;

function loadCollapsedProjects(): Set<string> {
  try {
    const raw = localStorage.getItem("nhicode_collapsed_projects");
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch {
    // ignore
  }
  return new Set();
}

function saveCollapsedProjects(collapsed: Set<string>): void {
  localStorage.setItem("nhicode_collapsed_projects", JSON.stringify([...collapsed]));
}

function closeStreamingMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) =>
    m.role === "assistant" || m.role === "thinking"
      ? m.isStreaming
        ? { ...m, isStreaming: false }
        : m
      : m,
  );
}

function updateSubAgentMessage(
  messages: ChatMessage[],
  toolCallId: string,
  updater: (sa: SubAgentMessage) => SubAgentMessage,
): ChatMessage[] {
  return messages.map((m) =>
    m.role === "subagent" && m.toolCallId === toolCallId ? updater(m) : m,
  );
}

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() =>
    loadCollapsedProjects(),
  );
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>("idle");
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("disconnected");
  const [activityLabel, setActivityLabel] = useState("");
  const [mode, setMode] = useState("agent");
  const [model, setModel] = useState("deepseek-v4-pro");
  const [providerId, setProviderId] = useState("deepseek");
  const [config, setConfig] = useState<Config | null>(null);
  const [providers, setProviders] = useState<string[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  const [theme, setTheme] = useState<Theme>(() => getStoredTheme());
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  const [statusNotice, setStatusNotice] = useState<StatusNotice | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const streamBufferRef = useRef({ text: "", thinking: "" });
  const lastActivityAtRef = useRef(0);
  const activeThreadIdRef = useRef<string | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wsGenerationRef = useRef(0);
  const sessionStatusRef = useRef<SessionStatus>("idle");

  const isBusy = sessionStatus === "running" || sessionStatus === "waiting_approval";

  useEffect(() => {
    sessionStatusRef.current = sessionStatus;
  }, [sessionStatus]);

  const touchActivity = useCallback(() => {
    lastActivityAtRef.current = Date.now();
  }, []);

  const showNotice = useCallback((kind: StatusNotice["kind"], message: string) => {
    setStatusNotice({ kind, message });
  }, []);

  const clearNotice = useCallback(() => setStatusNotice(null), []);

  useEffect(() => {
    activeThreadIdRef.current = activeThreadId;
  }, [activeThreadId]);

  useEffect(() => {
    async function boot() {
      for (let i = 0; i < 10; i++) {
        try {
          const boot = await fetchBootstrap();
          setProviders(boot.providers);
          setConfig(boot.config);
          setProjects(boot.projects);
          setThreads(boot.threads);

          if (boot.projects.length === 0) {
            let savedCwd = localStorage.getItem("nhicode_cwd") ?? "";
            if (!savedCwd) {
              savedCwd =
                localStorage.getItem("suprmodl_cwd") ??
                localStorage.getItem("supermodel_cwd") ??
                "";
            }
            if (savedCwd) {
              try {
                const project = await createProject({ path: savedCwd });
                setProjects([project]);
                setActiveProjectId(project.id);
                localStorage.setItem("nhicode_active_project", project.id);
              } catch {
                // path may already exist or be invalid
              }
            }
          }
          return;
        } catch {
          await new Promise((r) => setTimeout(r, 200));
        }
      }
    }
    boot();

    const savedProjectId = localStorage.getItem("nhicode_active_project");
    if (savedProjectId) setActiveProjectId(savedProjectId);
  }, []);

  useEffect(() => {
    if (sessionStatus !== "running") return;
    if (connectionStatus !== "disconnected" && connectionStatus !== "reconnecting") return;

    const interval = setInterval(() => {
      fetchHealth().catch(() => {});
    }, 5000);
    return () => clearInterval(interval);
  }, [sessionStatus, connectionStatus]);

  useEffect(() => {
    if (!isBusy) return;

    touchActivity();
    const interval = setInterval(() => {
      if (Date.now() - lastActivityAtRef.current < STALE_ACTIVITY_MS) return;
      showNotice(
        "warning",
        "No response from the agent — it may be stuck or the connection was lost.",
      );
    }, 5000);

    return () => clearInterval(interval);
  }, [isBusy, touchActivity, showNotice]);

  const updateThreadStatus = useCallback((threadId: string, status: SessionStatus) => {
    setThreads((prev) => prev.map((t) => (t.id === threadId ? { ...t, status } : t)));
  }, []);

  const handleStreamEvent = useCallback(
    (event: SessionEvent) => {
      const threadId = activeThreadIdRef.current;
      touchActivity();

      switch (event.type) {
        case "text_delta":
          setActivityLabel("Writing…");
          streamBufferRef.current.text = applyStreamDelta(
            streamBufferRef.current.text,
            event.content,
          );
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last?.role === "assistant" && last.isStreaming) {
              return [...prev.slice(0, -1), { ...last, content: streamBufferRef.current.text }];
            }
            return [
              ...prev,
              {
                id: `stream-${Date.now()}`,
                role: "assistant",
                content: streamBufferRef.current.text,
                isStreaming: true,
              },
            ];
          });
          break;

        case "thinking_delta":
          setActivityLabel("Thinking…");
          streamBufferRef.current.thinking = applyStreamDelta(
            streamBufferRef.current.thinking,
            event.content,
          );
          setMessages((prev) => {
            const thinkingIdx = prev.findIndex((m) => m.role === "thinking" && m.isStreaming);
            if (thinkingIdx >= 0) {
              const updated = [...prev];
              updated[thinkingIdx] = {
                ...updated[thinkingIdx],
                content: streamBufferRef.current.thinking,
              } as ThinkingMessage;
              return updated;
            }
            return [
              ...prev,
              {
                id: `thinking-${Date.now()}`,
                role: "thinking",
                content: streamBufferRef.current.thinking,
                isStreaming: true,
              },
            ];
          });
          break;

        case "tool_call": {
          streamBufferRef.current = emptyStreamBuffers();

          const toolName = event.call.function.name;
          const toolDisplay = getToolDisplay(toolName, event.call.function.arguments);

          if (toolName === "spawn_subagent") {
            const { profile, task } = parseSubAgentArgs(event.call.function.arguments);
            const profileLabel = SUBAGENT_PROFILE_LABEL[profile] ?? profile;
            setActivityLabel(`Sub-agent · ${profileLabel}`);
            setMessages((prev) => {
              if (prev.some((m) => m.role === "subagent" && m.toolCallId === event.call.id)) {
                return prev;
              }
              return [
                ...closeStreamingMessages(prev),
                {
                  id: `subagent-${event.call.id}`,
                  role: "subagent",
                  toolCallId: event.call.id,
                  profile,
                  task,
                  status: "running",
                  items: [],
                },
              ];
            });
            break;
          }

          setActivityLabel(`${toolDisplay.label} — ${toolDisplay.summary}`);
          setMessages((prev) => {
            if (prev.some((m) => m.role === "tool" && m.toolCallId === event.call.id)) {
              return closeStreamingMessages(prev);
            }
            return [
              ...closeStreamingMessages(prev),
              {
                id: `tool-${event.call.id}`,
                role: "tool",
                toolCallId: event.call.id,
                toolName,
                args: event.call.function.arguments,
                status: "running",
              },
            ];
          });
          break;
        }

        case "tool_result":
          setActivityLabel("Continuing…");
          setMessages((prev) =>
            prev.map((m) => {
              if (m.role === "subagent" && m.toolCallId === event.result.toolCallId) {
                clearSubAgentBuffers(event.result.toolCallId);
                return {
                  ...m,
                  result: event.result.content,
                  status: event.result.isError ? "error" : "done",
                  items: finalizeSubAgentItems(m.items),
                };
              }
              if (m.role !== "tool") return m;
              if (m.toolCallId !== event.result.toolCallId) return m;
              return {
                ...m,
                result: event.result.content,
                status: event.result.isError ? "error" : "done",
                isError: event.result.isError,
              };
            }),
          );
          break;

        case "subagent_spawned":
          setMessages((prev) =>
            updateSubAgentMessage(prev, event.toolCallId, (sa) => ({
              ...sa,
              sessionId: event.sessionId,
            })),
          );
          break;

        case "subagent_event": {
          const nested = event.event;
          if (nested.type === "text_delta") {
            setActivityLabel("Sub-agent writing…");
          } else if (nested.type === "thinking_delta") {
            setActivityLabel("Sub-agent thinking…");
          } else if (nested.type === "tool_call") {
            const nestedDisplay = getToolDisplay(
              nested.call.function.name,
              nested.call.function.arguments,
            );
            setActivityLabel(`Sub-agent · ${nestedDisplay.label}`);
          }
          setMessages((prev) =>
            updateSubAgentMessage(prev, event.toolCallId, (sa) => ({
              ...sa,
              items: applySubAgentEvent(sa.items, event.toolCallId, nested),
            })),
          );
          break;
        }

        case "subagent_completed":
          clearSubAgentBuffers(event.toolCallId);
          setMessages((prev) =>
            updateSubAgentMessage(prev, event.toolCallId, (sa) => ({
              ...sa,
              status: "done",
              result: event.result,
              items: finalizeSubAgentItems(sa.items),
            })),
          );
          setActivityLabel("Continuing…");
          break;

        case "approval_required":
          setActivityLabel("Waiting for approval");
          setPendingApproval({
            requestId: event.requestId,
            toolName: event.call.function.name,
            args: event.call.function.arguments,
            scopes: event.scopes,
            category: (event as any).category ?? "file",
          });
          break;

        case "status_changed":
          setSessionStatus(event.status);
          if (threadId) updateThreadStatus(threadId, event.status);
          if (event.status === "waiting_approval") {
            setActivityLabel("Waiting for approval");
          } else if (event.status === "running") {
            setActivityLabel((prev) => prev || "Working…");
          }
          break;

        case "turn_complete":
          setMessages((prev) =>
            prev.map((m) =>
              m.role === "assistant" || m.role === "thinking"
                ? m.isStreaming
                  ? { ...m, isStreaming: false }
                  : m
                : m,
            ),
          );
          {
            const result = event.result;
            const nextStatus: SessionStatus =
              result.status === "completed"
                ? "idle"
                : result.status === "cancelled"
                  ? "cancelled"
                  : "error";
            setSessionStatus(nextStatus);
            if (threadId) updateThreadStatus(threadId, nextStatus);

            if (result.status === "error") {
              showNotice("error", result.error ?? "The agent stopped due to an error.");
              if (result.error) {
                setMessages((prev) => [
                  ...prev,
                  {
                    id: `error-${Date.now()}`,
                    role: "assistant",
                    content: result.error!,
                    isError: true,
                  },
                ]);
              }
            } else if (result.status === "cancelled") {
              showNotice("info", "Stopped — the agent was cancelled.");
            } else {
              clearNotice();
            }
          }
          setActivityLabel("");
          streamBufferRef.current = { text: "", thinking: "" };
          fetchThreads().then(setThreads);
          break;

        case "error":
          setSessionStatus("error");
          if (threadId) updateThreadStatus(threadId, "error");
          setActivityLabel("");
          showNotice("error", event.error);
          setMessages((prev) => [
            ...prev,
            {
              id: `error-${Date.now()}`,
              role: "assistant",
              content: event.error,
              isError: true,
            },
          ]);
          break;

        case "mode_changed":
          setMode(event.mode);
          break;
      }
    },
    [updateThreadStatus, touchActivity, showNotice, clearNotice],
  );

  const connectWsRef = useRef<(sessionId: string) => void>(() => {});

  const scheduleReconnect = useCallback(
    (sessionId: string) => {
      if (activeThreadIdRef.current !== sessionId) return;
      if (reconnectAttemptsRef.current >= MAX_RECONNECT_ATTEMPTS) {
        const status = sessionStatusRef.current;
        if (status === "running" || status === "waiting_approval") {
          setSessionStatus("error");
          updateThreadStatus(sessionId, "error");
          setActivityLabel("");
          showNotice(
            "error",
            "Connection lost — could not reconnect to the agent. Your turn may have stopped.",
          );
        }
        return;
      }

      reconnectAttemptsRef.current += 1;
      setConnectionStatus("reconnecting");

      reconnectTimerRef.current = setTimeout(() => {
        if (activeThreadIdRef.current === sessionId) {
          connectWsRef.current(sessionId);
        }
      }, RECONNECT_DELAY_MS);
    },
    [updateThreadStatus, showNotice],
  );

  const connectWs = useCallback(
    (sessionId: string) => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }

      wsRef.current?.close();
      const gen = ++wsGenerationRef.current;
      setConnectionStatus("connecting");

      wsRef.current = connectWebSocket(sessionId, handleStreamEvent, {
        onOpen: () => {
          if (gen !== wsGenerationRef.current) return;
          setConnectionStatus("connected");
          reconnectAttemptsRef.current = 0;
        },
        onClose: () => {
          if (gen !== wsGenerationRef.current) return;
          setConnectionStatus("disconnected");
          scheduleReconnect(sessionId);
        },
        onError: () => {
          if (gen !== wsGenerationRef.current) return;
          setConnectionStatus("disconnected");
        },
      });
    },
    [handleStreamEvent, scheduleReconnect],
  );

  connectWsRef.current = connectWs;

  useEffect(() => {
    return () => {
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, []);

  const selectThread = useCallback(
    async (id: string) => {
      localStorage.setItem("nhicode_active_thread", id);
      setActiveThreadId(id);
      setSessionStatus("idle");
      setActivityLabel("");
      clearNotice();
      reconnectAttemptsRef.current = 0;
      streamBufferRef.current = { text: "", thinking: "" };

      const thread = threads.find((t) => t.id === id);
      if (thread) {
        setMode(thread.mode);
        setModel(thread.model);
        if (thread.projectId) {
          setActiveProjectId(thread.projectId);
          localStorage.setItem("nhicode_active_project", thread.projectId);
        }
        if (thread.status !== "running") {
          setSessionStatus(thread.status);
        }
      }

      connectWs(id);

      try {
        const stored = await fetchThreadMessages(id);
        setMessages(storedMessagesToChat(stored));
      } catch {
        setMessages([]);
      }
    },
    [threads, connectWs, clearNotice],
  );

  useEffect(() => {
    if (threads.length === 0 || activeThreadId) return;
    const savedId = localStorage.getItem("nhicode_active_thread");
    const savedProjectId = localStorage.getItem("nhicode_active_project");

    let id = savedId && threads.some((t) => t.id === savedId) ? savedId : undefined;
    if (!id && savedProjectId) {
      id = threads.find((t) => t.projectId === savedProjectId)?.id;
    }
    if (!id) id = threads[0]?.id;
    if (id) void selectThread(id);
  }, [threads, activeThreadId, selectThread]);

  const handleToggleProjectCollapsed = useCallback((projectId: string) => {
    setCollapsedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      saveCollapsedProjects(next);
      return next;
    });
  }, []);

  const handleAddProject = useCallback(
    async (path: string, name?: string) => {
      const project = await createProject({ path, name });
      setProjects((prev) => [project, ...prev]);
      setActiveProjectId(project.id);
      localStorage.setItem("nhicode_active_project", project.id);
      setCollapsedProjects((prev) => {
        const next = new Set(prev);
        next.delete(project.id);
        saveCollapsedProjects(next);
        return next;
      });
    },
    [],
  );

  const handleDeleteProject = useCallback(
    async (projectId: string) => {
      await deleteProject(projectId);
      setProjects((prev) => prev.filter((p) => p.id !== projectId));
      setThreads((prev) => prev.filter((t) => t.projectId !== projectId));
      if (activeProjectId === projectId) {
        setActiveProjectId(null);
        localStorage.removeItem("nhicode_active_project");
      }
      if (activeThreadId) {
        const thread = threads.find((t) => t.id === activeThreadId);
        if (thread?.projectId === projectId) {
          setActiveThreadId(null);
          setMessages([]);
          localStorage.removeItem("nhicode_active_thread");
          wsRef.current?.close();
        }
      }
    },
    [activeProjectId, activeThreadId, threads],
  );

  const handleRenameProject = useCallback(async (projectId: string, name: string) => {
    const updated = await updateProject(projectId, { name });
    setProjects((prev) => prev.map((p) => (p.id === projectId ? updated : p)));
  }, []);

  const handleToggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next: Theme = prev === "dark" ? "light" : "dark";
      applyTheme(next);
      return next;
    });
  }, []);

  useEffect(() => {
    return () => {
      wsGenerationRef.current += 1;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      wsRef.current?.close();
    };
  }, []);

  const handleNewThread = async (projectId: string) => {
    setActiveProjectId(projectId);
    localStorage.setItem("nhicode_active_project", projectId);
    try {
      const thread = await createThread({ projectId, mode, model, providerId });
      const summary: ThreadSummary = {
        id: thread.id,
        title: "New thread",
        cwd: thread.cwd,
        projectId: thread.projectId ?? projectId,
        mode: thread.mode,
        model: thread.model,
        providerId,
        status: thread.status as ThreadSummary["status"],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      setThreads((prev) => [summary, ...prev]);
      localStorage.setItem("nhicode_active_thread", thread.id);
      setActiveThreadId(thread.id);
      setMessages([]);
      setSessionStatus("idle");
      setActivityLabel("");
      clearNotice();
      reconnectAttemptsRef.current = 0;
      connectWs(thread.id);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSelectThread = (id: string) => {
    void selectThread(id);
  };

  const handleSend = async (text: string) => {
    if (!activeThreadId || isBusy) return;

    clearNotice();
    setMessages((prev) => [...prev, { id: `user-${Date.now()}`, role: "user", content: text }]);
    streamBufferRef.current = { text: "", thinking: "" };
    setSessionStatus("running");
    setActivityLabel("Working…");
    touchActivity();
    if (activeThreadId) updateThreadStatus(activeThreadId, "running");

    try {
      await sendMessage(activeThreadId, text);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setMessages((prev) => [
        ...prev,
        {
          id: `error-${Date.now()}`,
          role: "assistant",
          content: message,
          isError: true,
        },
      ]);
      setSessionStatus("error");
      setActivityLabel("");
      showNotice("error", message);
      if (activeThreadId) updateThreadStatus(activeThreadId, "error");
    }
  };

  const handleModeChange = async (newMode: string) => {
    setMode(newMode);
    if (activeThreadId) {
      await setThreadMode(activeThreadId, newMode);
    }
  };

  const handleCancel = async () => {
    if (activeThreadId) await cancelThread(activeThreadId);
    setSessionStatus("idle");
    setActivityLabel("");
    showNotice("info", "Stopped — you cancelled the agent.");
  };

  const handleApproval = async (decision: ApprovalResponse["decision"]) => {
    if (!activeThreadId || !pendingApproval) return;
    await respondToApproval(activeThreadId, {
      requestId: pendingApproval.requestId,
      decision,
      category: pendingApproval.category as any,
    });
    setPendingApproval(null);
    if (decision !== "deny") {
      setSessionStatus("running");
      setActivityLabel("Working…");
    }
  };

  const displayActivityLabel = useMemo(() => {
    if (sessionStatus === "waiting_approval") return "Waiting for approval";
    if (activityLabel) return activityLabel;
    if (isBusy) return "Working…";
    return "";
  }, [sessionStatus, activityLabel, isBusy]);

  const activeProject = projects.find((p) => p.id === activeProjectId);

  const handleChatNewThread = () => {
    if (activeProjectId) {
      void handleNewThread(activeProjectId);
    }
  };

  return (
    <div className="app">
      <Sidebar
        projects={projects}
        threads={threads}
        activeProjectId={activeProjectId}
        activeThreadId={activeThreadId}
        collapsedProjects={collapsedProjects}
        theme={theme}
        onToggleTheme={handleToggleTheme}
        onSelectThread={handleSelectThread}
        onNewThread={handleNewThread}
        onAddProject={handleAddProject}
        onDeleteProject={(id) => void handleDeleteProject(id)}
        onRenameProject={(id, name) => void handleRenameProject(id, name)}
        onToggleProjectCollapsed={handleToggleProjectCollapsed}
        onOpenSettings={() => setShowSettings(true)}
        providers={providers}
      />
      <ChatPanel
        messages={messages}
        sessionStatus={sessionStatus}
        connectionStatus={connectionStatus}
        activityLabel={displayActivityLabel}
        isBusy={isBusy}
        mode={mode}
        model={model}
        providerId={providerId}
        config={config}
        projectName={activeProject?.name}
        hasActiveThread={!!activeThreadId}
        onSend={handleSend}
        onModeChange={handleModeChange}
        onModelChange={setModel}
        onProviderChange={setProviderId}
        onCancel={handleCancel}
        onNewThread={handleChatNewThread}
        statusNotice={statusNotice}
        onDismissNotice={clearNotice}
      />
      {showSettings && (
        <SettingsModal
          config={config}
          providers={providers}
          onClose={() => setShowSettings(false)}
          onProvidersChange={setProviders}
        />
      )}
      {pendingApproval && (
        <ApprovalModal
          approval={pendingApproval}
          onDecision={handleApproval}
          onClose={() => handleApproval("deny")}
        />
      )}
    </div>
  );
}
