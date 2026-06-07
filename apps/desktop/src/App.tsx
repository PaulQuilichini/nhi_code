import { useState, useEffect, useCallback, useRef } from "react";
import type { SessionEvent, ThreadSummary, ApprovalResponse } from "@nhicode/shared";
import {
  fetchThreads,
  createThread,
  sendMessage,
  setThreadMode,
  cancelThread,
  respondToApproval,
  connectWebSocket,
  fetchConfig,
  fetchHealth,
  type Config,
} from "./api";
import { Sidebar } from "./components/Sidebar";
import { ChatPanel } from "./components/ChatPanel";
import { SettingsModal } from "./components/SettingsModal";
import { ApprovalModal } from "./components/ApprovalModal";
import "./styles/app.css";

export interface UserMessage {
  id: string;
  role: "user";
  content: string;
}

export interface AssistantMessage {
  id: string;
  role: "assistant";
  content: string;
  isStreaming?: boolean;
}

export interface ThinkingMessage {
  id: string;
  role: "thinking";
  content: string;
  isStreaming?: boolean;
}

export interface ToolMessage {
  id: string;
  role: "tool";
  toolCallId: string;
  toolName: string;
  args: string;
  result?: string;
  status: "running" | "done" | "error";
  isError?: boolean;
}

export type ChatMessage = UserMessage | AssistantMessage | ThinkingMessage | ToolMessage;

export interface PendingApproval {
  requestId: string;
  toolName: string;
  args: string;
  scopes: string[];
}

export default function App() {
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [cwd, setCwd] = useState("");
  const [mode, setMode] = useState("agent");
  const [model, setModel] = useState("deepseek-v4-pro");
  const [providerId, setProviderId] = useState("deepseek");
  const [config, setConfig] = useState<Config | null>(null);
  const [providers, setProviders] = useState<string[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const streamBufferRef = useRef({ text: "", thinking: "" });

  useEffect(() => {
    async function boot() {
      for (let i = 0; i < 30; i++) {
        try {
          const [h, c, t] = await Promise.all([fetchHealth(), fetchConfig(), fetchThreads()]);
          setProviders(h.providers);
          setConfig(c);
          setThreads(t);
          return;
        } catch {
          await new Promise((r) => setTimeout(r, 300));
        }
      }
    }
    boot();
    let savedCwd = localStorage.getItem("nhicode_cwd") ?? "";
    if (!savedCwd) {
      savedCwd =
        localStorage.getItem("suprmodl_cwd") ?? localStorage.getItem("supermodel_cwd") ?? "";
      if (savedCwd) localStorage.setItem("nhicode_cwd", savedCwd);
    }
    setCwd(savedCwd);
  }, []);

  const handleStreamEvent = useCallback((event: SessionEvent) => {
    switch (event.type) {
      case "text_delta":
        streamBufferRef.current.text += event.content;
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
        streamBufferRef.current.thinking += event.content;
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

      case "tool_call":
        setMessages((prev) => [
          ...prev.map((m) =>
            m.role === "assistant" || m.role === "thinking"
              ? m.isStreaming
                ? { ...m, isStreaming: false }
                : m
              : m,
          ),
          {
            id: `tool-${event.call.id}`,
            role: "tool",
            toolCallId: event.call.id,
            toolName: event.call.function.name,
            args: event.call.function.arguments,
            status: "running",
          },
        ]);
        break;

      case "tool_result":
        setMessages((prev) =>
          prev.map((m) => {
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

      case "approval_required":
        setPendingApproval({
          requestId: event.requestId,
          toolName: event.call.function.name,
          args: event.call.function.arguments,
          scopes: event.scopes,
        });
        break;

      case "status_changed":
        setIsRunning(event.status === "running");
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
        setIsRunning(false);
        streamBufferRef.current = { text: "", thinking: "" };
        fetchThreads().then(setThreads);
        break;

      case "mode_changed":
        setMode(event.mode);
        break;
    }
  }, []);

  const connectWs = useCallback(
    (sessionId: string) => {
      wsRef.current?.close();
      wsRef.current = connectWebSocket(sessionId, handleStreamEvent);
    },
    [handleStreamEvent],
  );

  const handleNewThread = async () => {
    if (!cwd) {
      setShowSettings(true);
      return;
    }
    localStorage.setItem("nhicode_cwd", cwd);
    try {
      const thread = await createThread({ cwd, mode, model, providerId });
      setThreads((prev) => [
        {
          id: thread.id,
          title: "New thread",
          cwd: thread.cwd,
          mode: thread.mode,
          model: thread.model,
          status: thread.status as ThreadSummary["status"],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        ...prev,
      ]);
      setActiveThreadId(thread.id);
      setMessages([]);
      connectWs(thread.id);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSelectThread = (id: string) => {
    setActiveThreadId(id);
    setMessages([]);
    const thread = threads.find((t) => t.id === id);
    if (thread) {
      setMode(thread.mode);
      setModel(thread.model);
    }
    connectWs(id);
  };

  const handleSend = async (text: string) => {
    if (!activeThreadId || isRunning) return;

    setMessages((prev) => [...prev, { id: `user-${Date.now()}`, role: "user", content: text }]);
    streamBufferRef.current = { text: "", thinking: "" };
    setIsRunning(true);

    try {
      await sendMessage(activeThreadId, text);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          id: `error-${Date.now()}`,
          role: "assistant",
          content: `Error: ${err instanceof Error ? err.message : String(err)}`,
        },
      ]);
      setIsRunning(false);
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
    setIsRunning(false);
  };

  const handleApproval = async (decision: ApprovalResponse["decision"]) => {
    if (!activeThreadId || !pendingApproval) return;
    await respondToApproval(activeThreadId, {
      requestId: pendingApproval.requestId,
      decision,
    });
    setPendingApproval(null);
  };

  return (
    <div className="app">
      <Sidebar
        threads={threads}
        activeThreadId={activeThreadId}
        onSelectThread={handleSelectThread}
        onNewThread={handleNewThread}
        onOpenSettings={() => setShowSettings(true)}
        providers={providers}
      />
      <ChatPanel
        messages={messages}
        isRunning={isRunning}
        mode={mode}
        model={model}
        providerId={providerId}
        config={config}
        hasActiveThread={!!activeThreadId}
        onSend={handleSend}
        onModeChange={handleModeChange}
        onModelChange={setModel}
        onProviderChange={setProviderId}
        onCancel={handleCancel}
        onNewThread={handleNewThread}
      />
      {showSettings && (
        <SettingsModal
          cwd={cwd}
          onCwdChange={setCwd}
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
