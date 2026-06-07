import { useState, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import type { ChatMessage, ToolMessage } from "../App";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolCallCard } from "./ToolCallCard";
import type { Config } from "../api";

interface ChatPanelProps {
  messages: ChatMessage[];
  isRunning: boolean;
  mode: string;
  model: string;
  providerId: string;
  config: Config | null;
  hasActiveThread: boolean;
  onSend: (text: string) => void;
  onModeChange: (mode: string) => void;
  onModelChange: (model: string) => void;
  onProviderChange: (id: string) => void;
  onCancel: () => void;
  onNewThread: () => void;
}

const MODES = [
  { id: "plan", label: "Plan", desc: "Design without changes" },
  { id: "agent", label: "Agent", desc: "Full coding access" },
  { id: "ask", label: "Ask", desc: "Read-only Q&A" },
];

type RenderBlock =
  | { kind: "user"; message: ChatMessage & { role: "user" } }
  | { kind: "agent-turn"; items: ChatMessage[]; isActive: boolean };

function isStreamingMessage(m: ChatMessage): boolean {
  return (m.role === "assistant" || m.role === "thinking") && !!m.isStreaming;
}

function groupMessages(messages: ChatMessage[], isRunning: boolean): RenderBlock[] {
  const blocks: RenderBlock[] = [];
  let agentItems: ChatMessage[] = [];

  const flushAgent = (isActive: boolean) => {
    if (agentItems.length > 0) {
      blocks.push({ kind: "agent-turn", items: agentItems, isActive });
      agentItems = [];
    } else if (isActive) {
      blocks.push({ kind: "agent-turn", items: [], isActive: true });
    }
  };

  for (const msg of messages) {
    if (msg.role === "user") {
      flushAgent(false);
      blocks.push({ kind: "user", message: msg });
    } else {
      agentItems.push(msg);
    }
  }

  const lastIsUser = messages.length > 0 && messages[messages.length - 1].role === "user";
  const hasRunningTools = agentItems.some(
    (m) => m.role === "tool" && m.status === "running",
  );
  if (isRunning && (lastIsUser || hasRunningTools || agentItems.some(isStreamingMessage))) {
    flushAgent(true);
  } else {
    flushAgent(false);
  }

  return blocks;
}

export function ChatPanel({
  messages,
  isRunning,
  mode,
  model,
  providerId,
  config,
  hasActiveThread,
  onSend,
  onModeChange,
  onModelChange,
  onProviderChange,
  onCancel,
  onNewThread,
}: ChatPanelProps) {
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isRunning]);

  const handleSubmit = () => {
    const text = input.trim();
    if (!text || isRunning) return;
    setInput("");
    onSend(text);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const modelOptions = config?.providers ?? [];
  const blocks = groupMessages(messages, isRunning);

  return (
    <main className="chat-panel">
      <div className="chat-header">
        <div className="mode-selector">
          {MODES.map((m) => (
            <button
              key={m.id}
              className={`mode-btn ${mode === m.id ? "active" : ""}`}
              onClick={() => onModeChange(m.id)}
              title={m.desc}
            >
              {m.label}
            </button>
          ))}
        </div>

        <select
          className="model-select"
          value={`${providerId}:${model}`}
          onChange={(e) => {
            const [pid, mid] = e.target.value.split(":");
            onProviderChange(pid);
            onModelChange(mid);
          }}
        >
          {modelOptions.map((p) => (
            <option key={p.id} value={`${p.id}:${p.default_model}`}>
              {p.id} / {p.default_model}
            </option>
          )) ?? (
            <option value="deepseek:deepseek-v4-pro">deepseek / deepseek-v4-pro</option>
          )}
        </select>
      </div>

      {!hasActiveThread ? (
        <div className="empty-state">
          <h2>NHI Code</h2>
          <p>
            AI coding agent for DeepSeek, Kimi, Qwen and other models.
            Create a new thread to get started.
          </p>
          <button className="btn btn-primary" onClick={onNewThread}>
            + New Thread
          </button>
        </div>
      ) : (
        <div className="chat-messages">
          {blocks.map((block, idx) =>
            block.kind === "user" ? (
              <UserBubble key={block.message.id} content={block.message.content} />
            ) : (
              <AgentTurn key={`turn-${idx}`} items={block.items} isActive={block.isActive} />
            ),
          )}
          <div ref={messagesEndRef} />
        </div>
      )}

      {hasActiveThread && (
        <div className="chat-input-area">
          <div className="input-wrapper">
            <textarea
              className="chat-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                mode === "plan"
                  ? "Describe what you want to build or explore…"
                  : mode === "ask"
                    ? "Ask a question about the codebase…"
                    : "Tell the agent what to do…"
              }
              disabled={isRunning}
              rows={1}
            />
            {isRunning && (
              <button className="cancel-btn" onClick={onCancel}>
                Cancel
              </button>
            )}
            <button
              className="send-btn"
              onClick={handleSubmit}
              disabled={!input.trim() || isRunning}
            >
              ↑
            </button>
          </div>
          <div className="input-hint">
            {mode === "plan" && "Plan mode — read-only exploration, no file changes"}
            {mode === "agent" && "Agent mode — can edit files and run commands with approval"}
            {mode === "ask" && "Ask mode — read-only Q&A"}
          </div>
        </div>
      )}
    </main>
  );
}

function UserBubble({ content }: { content: string }) {
  return (
    <div className="message message-user">
      <div className="message-content">{content}</div>
    </div>
  );
}

function AgentTurn({ items, isActive }: { items: ChatMessage[]; isActive: boolean }) {
  const thinking = items.find((m) => m.role === "thinking");
  const tools = items.filter((m) => m.role === "tool") as ToolMessage[];
  const assistantParts = items.filter((m) => m.role === "assistant");

  return (
    <div className={`agent-turn ${isActive ? "agent-turn-active" : ""}`}>
      {thinking && (
        <ThinkingBlock
          content={thinking.content}
          isStreaming={thinking.isStreaming}
          defaultCollapsed={!thinking.isStreaming}
        />
      )}

      {tools.length > 0 && (
        <div className="tool-stack">
          {tools.map((tool) => (
            <ToolCallCard key={tool.id} tool={tool} />
          ))}
        </div>
      )}

      {assistantParts.map((msg) => (
        <div key={msg.id} className="message message-assistant">
          <div className="message-content assistant-markdown">
            {msg.content ? <ReactMarkdown>{msg.content}</ReactMarkdown> : null}
            {msg.isStreaming && !msg.content && (
              <span className="working-indicator inline">
                <span className="tool-spinner" />
              </span>
            )}
            {msg.isStreaming && msg.content && <span className="cursor-blink">▍</span>}
          </div>
        </div>
      ))}

      {isActive && items.length === 0 && (
        <div className="working-indicator">
          <span className="tool-spinner" />
          Working…
        </div>
      )}
    </div>
  );
}
