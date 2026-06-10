import { useState, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import type {
  ContextBudgetTier,
  ContextDiagnostics,
  QueuedPrompt,
  SessionStatus,
} from "@nhicode/shared";
import type { ChatMessage, SubAgentMessage, ToolMessage, StatusNotice } from "../chatTypes";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolCallCard, ToolCallGroup } from "./ToolCallCard";
import { SubAgentCard } from "./SubAgentCard";
import type { Config } from "../api";

type ConnectionStatus = "connecting" | "connected" | "disconnected" | "reconnecting";

interface ChatPanelProps {
  messages: ChatMessage[];
  sessionStatus: SessionStatus;
  connectionStatus: ConnectionStatus;
  activityLabel: string;
  isBusy: boolean;
  statusNotice: StatusNotice | null;
  onDismissNotice: () => void;
  contextDiagnostics: ContextDiagnostics | null;
  threadTokenUsage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  queuedPrompts: QueuedPrompt[];
  mode: string;
  model: string;
  providerId: string;
  modelMode?: string;
  contextBudgetTier: ContextBudgetTier;
  config: Config | null;
  projectName?: string;
  hasActiveThread: boolean;
  onSend: (text: string) => void;
  onSteer: (text: string) => void;
  onQueuePrompt: (text: string) => void;
  onDeleteQueuedPrompt: (id: string) => void;
  onModeChange: (mode: string) => void;
  onModelChange: (model: string) => void;
  onProviderChange: (id: string) => void;
  onModelModeChange: (mode?: string) => void;
  onContextBudgetTierChange: (tier: ContextBudgetTier) => void;
  onCancel: () => void;
  onNewThread: () => void;
}

const MODES = [
  { id: "plan", label: "Plan", desc: "Design without changes" },
  { id: "agent", label: "Agent", desc: "Full coding access" },
  { id: "ask", label: "Ask", desc: "Read-only Q&A" },
];

const DEEPSEEK_MODES = [
  { id: "deepseek-off", label: "No reasoning" },
  { id: "deepseek-low", label: "Low reasoning" },
  { id: "deepseek-medium", label: "Medium reasoning" },
  { id: "deepseek-high", label: "High reasoning" },
  { id: "deepseek-max", label: "Maximum reasoning" },
];

const KIMI_MODES = [
  { id: "kimi-off", label: "No thinking" },
  { id: "kimi-on", label: "Thinking" },
  { id: "kimi-preserve", label: "Preserve thinking" },
];

const CONTEXT_TIERS: Array<{ id: ContextBudgetTier; label: string }> = [
  { id: "compact", label: "Compact context" },
  { id: "long", label: "Long context" },
  { id: "full", label: "Full context" },
];

type RenderBlock =
  | { kind: "user"; message: ChatMessage & { role: "user" } }
  | { kind: "agent-turn"; items: ChatMessage[]; isActive: boolean };

function isStreamingMessage(m: ChatMessage): boolean {
  return (m.role === "assistant" || m.role === "thinking") && !!m.isStreaming;
}

function groupMessages(messages: ChatMessage[], isBusy: boolean): RenderBlock[] {
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

  if (isBusy) {
    flushAgent(true);
  } else {
    flushAgent(false);
  }

  return blocks;
}

export function ChatPanel({
  messages,
  sessionStatus,
  connectionStatus,
  activityLabel,
  isBusy,
  statusNotice,
  onDismissNotice,
  contextDiagnostics,
  threadTokenUsage,
  queuedPrompts,
  mode,
  model,
  providerId,
  modelMode,
  contextBudgetTier,
  config,
  projectName,
  hasActiveThread,
  onSend,
  onSteer,
  onQueuePrompt,
  onDeleteQueuedPrompt,
  onModeChange,
  onModelChange,
  onProviderChange,
  onModelModeChange,
  onContextBudgetTierChange,
  onCancel,
  onNewThread,
}: ChatPanelProps) {
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isBusy]);

  const handleSubmit = () => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    if (isBusy) {
      onSteer(text);
      return;
    }
    onSend(text);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const modelOptions = config?.providers ?? [];
  const blocks = groupMessages(messages, isBusy);
  const modelModeOptions = modelModesForSelection(providerId, model);
  const showDisconnected =
    connectionStatus === "disconnected" || connectionStatus === "reconnecting";
  const statusText =
    sessionStatus === "waiting_approval"
      ? "Waiting for approval"
      : activityLabel || (isBusy ? "Working…" : "Ready");

  return (
    <main className="chat-panel">
      <div className="chat-header">
        {projectName && <span className="chat-project-label">{projectName}</span>}
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
            onModelModeChange(defaultModelModeForSelection(pid, mid));
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

        {modelModeOptions.length > 0 && (
          <select
            className="model-mode-select"
            value={modelMode ?? modelModeOptions[0].id}
            onChange={(e) => onModelModeChange(e.target.value)}
          >
            {modelModeOptions.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        )}

        <select
          className="context-tier-select"
          value={contextBudgetTier}
          onChange={(e) => onContextBudgetTierChange(e.target.value as ContextBudgetTier)}
        >
          {CONTEXT_TIERS.map((tier) => (
            <option key={tier.id} value={tier.id}>
              {tier.label}
            </option>
          ))}
        </select>
      </div>

      {hasActiveThread && (
        <div className={`agent-status-bar ${isBusy ? "is-busy" : ""}`}>
          <span className={`connection-dot ${connectionStatus}`} title={`Connection: ${connectionStatus}`} />
          {isBusy && <span className="tool-spinner status-spinner" aria-hidden />}
          <span className="activity-label">{statusText}</span>
          {sessionStatus === "error" && !isBusy && (
            <span className="status-badge status-badge-error">Error</span>
          )}
        </div>
      )}

      {hasActiveThread && contextDiagnostics && (
        <ContextDiagnosticsBar diagnostics={contextDiagnostics} threadTokenUsage={threadTokenUsage} />
      )}

      {hasActiveThread && statusNotice && (
        <div className={`status-notice status-notice-${statusNotice.kind}`} role="alert">
          <span className="status-notice-message">{statusNotice.message}</span>
          <button
            type="button"
            className="status-notice-dismiss"
            onClick={onDismissNotice}
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      {hasActiveThread && showDisconnected && isBusy && (
        <div className="connection-banner">
          {connectionStatus === "reconnecting"
            ? "Reconnecting — agent is still running…"
            : "Disconnected — trying to reconnect…"}
        </div>
      )}

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
              <AgentTurn
                key={`turn-${idx}`}
                items={block.items}
                isActive={block.isActive}
                activityLabel={activityLabel}
              />
            ),
          )}
          <div ref={messagesEndRef} />
        </div>
      )}

      {hasActiveThread && (
        <div className="chat-input-area">
          {queuedPrompts.length > 0 && (
            <div className="queued-prompts">
              <div className="queued-prompts-header">
                <span>Queued prompts</span>
                <span>{queuedPrompts.length}</span>
              </div>
              <div className="queued-prompts-list">
                {queuedPrompts.map((prompt) => (
                  <div key={prompt.id} className="queued-prompt-row">
                    <div className="queued-prompt-text">{prompt.text}</div>
                    <button
                      type="button"
                      className="queued-prompt-remove"
                      onClick={() => onDeleteQueuedPrompt(prompt.id)}
                      aria-label="Remove queued prompt"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
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
                    : isBusy
                      ? "Steer the current run or queue the next prompt…"
                      : "Tell the agent what to do…"
              }
              rows={1}
            />
            {isBusy && (
              <>
                <button
                  type="button"
                  className="queue-btn"
                  onClick={() => {
                    const text = input.trim();
                    if (!text) return;
                    setInput("");
                    onQueuePrompt(text);
                  }}
                  disabled={!input.trim()}
                >
                  Queue
                </button>
                <button className="cancel-btn" onClick={onCancel}>
                  Cancel
                </button>
              </>
            )}
            <button
              className="send-btn"
              onClick={handleSubmit}
              disabled={!input.trim()}
            >
              {isBusy ? "Steer" : "↑"}
            </button>
          </div>
          <div className="input-hint">
            {isBusy ? (
              <span className="input-activity">
                <span className="tool-spinner input-activity-spinner" aria-hidden />
                {statusText} Use Steer for the current run or Queue for the next prompt.
              </span>
            ) : (
              <>
                {mode === "plan" && "Plan mode — read-only exploration, no file changes"}
                {mode === "agent" && "Agent mode — can edit files and run commands with approval"}
                {mode === "ask" && "Ask mode — read-only Q&A"}
              </>
            )}
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

function AgentTurn({
  items,
  isActive,
  activityLabel,
}: {
  items: ChatMessage[];
  isActive: boolean;
  activityLabel: string;
}) {
  const thinking = items.find((m) => m.role === "thinking");
  const subagents = items.filter((m) => m.role === "subagent") as SubAgentMessage[];
  const tools = items.filter((m) => m.role === "tool") as ToolMessage[];
  const assistantParts = items.filter((m) => m.role === "assistant");
  const isStreaming = items.some(isStreamingMessage);
  const hasRunningTool = tools.some((t) => t.status === "running");
  const hasRunningSubAgent = subagents.some((s) => s.status === "running");
  const showFooter =
    isActive && !isStreaming && (items.length === 0 || (!hasRunningTool && !hasRunningSubAgent));

  return (
    <div className={`agent-turn ${isActive ? "agent-turn-active" : ""}`}>
      {thinking && (
        <ThinkingBlock
          content={thinking.content}
          isStreaming={thinking.isStreaming}
          defaultCollapsed={!thinking.isStreaming}
        />
      )}

      {subagents.length > 0 && (
        <div className="subagent-stack">
          {subagents.map((sa) => (
            <SubAgentCard key={sa.id} subagent={sa} />
          ))}
        </div>
      )}

      {tools.length > 0 && (
        <div className="tool-stack">
          {tools.length >= 4 ? (
            <ToolCallGroup tools={tools} />
          ) : (
            tools.map((tool) => <ToolCallCard key={tool.id} tool={tool} />)
          )}
        </div>
      )}

      {assistantParts.map((msg) => (
        <div
          key={msg.id}
          className={`message message-assistant ${msg.isError ? "message-error" : ""}`}
        >
          <div className="message-content assistant-markdown">
            {msg.isError && <div className="error-label">Agent stopped</div>}
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

      {showFooter && (
        <div className="working-indicator turn-footer">
          <span className="tool-spinner" />
          {activityLabel || "Working…"}
        </div>
      )}
    </div>
  );
}

function ContextDiagnosticsBar({
  diagnostics,
  threadTokenUsage,
}: {
  diagnostics: ContextDiagnostics;
  threadTokenUsage: { promptTokens: number; completionTokens: number; totalTokens: number };
}) {
  const prompt = diagnostics.promptTokens ?? diagnostics.adjustedInputTokens ?? diagnostics.estimatedInputTokens;
  const cacheHit = diagnostics.cacheHitTokens ?? 0;
  const cacheMiss = diagnostics.cacheMissTokens ?? 0;
  const completion = diagnostics.completionTokens ?? 0;
  const total = diagnostics.totalTokens ?? prompt + completion;
  return (
    <details className="context-diagnostics">
      <summary>
        <span>Thread {formatNumber(threadTokenUsage.totalTokens)} total</span>
        <span>Prompt {formatNumber(prompt)}</span>
        <span>Output {formatNumber(completion)}</span>
        <span>Request {formatNumber(total)}</span>
        {diagnostics.contextBudgetTier && <span>{diagnostics.contextBudgetTier} tier</span>}
        <span>
          Context {formatNumber(diagnostics.adjustedInputTokens ?? diagnostics.estimatedInputTokens)} /{" "}
          {formatNumber(diagnostics.inputBudgetTokens)}
        </span>
        {diagnostics.compactionCount !== undefined && diagnostics.compactionCount > 0 && (
          <span>Compacted {formatNumber(diagnostics.compactionCount)}x</span>
        )}
        {diagnostics.tokenSafetyFactor !== undefined && diagnostics.tokenSafetyFactor < 1 && (
          <span>{Math.round(diagnostics.tokenSafetyFactor * 100)}% safety</span>
        )}
        {diagnostics.promptInflationFactor !== undefined && diagnostics.promptInflationFactor > 1 && (
          <span>{diagnostics.promptInflationFactor.toFixed(2)}x inflation</span>
        )}
        {(cacheHit > 0 || cacheMiss > 0) && (
          <span>Cache {formatNumber(cacheHit)} hit / {formatNumber(cacheMiss)} miss</span>
        )}
        {diagnostics.suppressedObservationTokens > 0 && (
          <span>{formatNumber(diagnostics.suppressedObservationTokens)} obs tokens suppressed</span>
        )}
      </summary>
      <div className="context-diagnostics-body">
        {diagnostics.slots.map((slot) => (
          <div key={slot.name} className="context-slot-row">
            <span>{slot.name.replace(/_/g, " ")}</span>
            <span>
              {formatNumber(slot.tokens)}
              {slot.budgetTokens ? ` / ${formatNumber(slot.budgetTokens)}` : ""}
              {slot.truncated ? " truncated" : ""}
            </span>
          </div>
        ))}
        {diagnostics.completionTokens !== undefined && (
          <div className="context-slot-row">
            <span>completion</span>
            <span>{formatNumber(diagnostics.completionTokens)}</span>
          </div>
        )}
        {diagnostics.estimatedToolTokens !== undefined && diagnostics.estimatedToolTokens > 0 && (
          <div className="context-slot-row">
            <span>tool schema est.</span>
            <span>{formatNumber(diagnostics.estimatedToolTokens)}</span>
          </div>
        )}
        {diagnostics.promptCeilingTokens !== undefined && (
          <div className="context-slot-row">
            <span>compact at</span>
            <span>{formatNumber(diagnostics.promptCeilingTokens)}</span>
          </div>
        )}
        {diagnostics.hardPromptCeilingTokens !== undefined && (
          <div className="context-slot-row">
            <span>hard ceiling</span>
            <span>{formatNumber(diagnostics.hardPromptCeilingTokens)}</span>
          </div>
        )}
        {diagnostics.modelTurnsSinceCompaction !== undefined && (
          <div className="context-slot-row">
            <span>model turns since compact</span>
            <span>{formatNumber(diagnostics.modelTurnsSinceCompaction)}</span>
          </div>
        )}
        {diagnostics.toolCallsSinceCompaction !== undefined && (
          <div className="context-slot-row">
            <span>tool calls since compact</span>
            <span>{formatNumber(diagnostics.toolCallsSinceCompaction)}</span>
          </div>
        )}
      </div>
    </details>
  );
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(Math.round(value));
}

function modelModesForSelection(
  providerId: string,
  model: string,
): Array<{ id: string; label: string }> {
  if (`${providerId} ${model}`.toLocaleLowerCase().includes("deepseek")) {
    return DEEPSEEK_MODES;
  }
  if (supportsKimiThinking(providerId, model)) {
    return KIMI_MODES;
  }
  return [];
}

function defaultModelModeForSelection(providerId: string, model: string): string | undefined {
  if (`${providerId} ${model}`.toLocaleLowerCase().includes("deepseek")) return "deepseek-high";
  if (supportsKimiThinking(providerId, model)) return "kimi-on";
  return undefined;
}

function supportsKimiThinking(providerId: string, model: string): boolean {
  const value = `${providerId} ${model}`.toLocaleLowerCase();
  return value.includes("kimi") && /^kimi-k2\./.test(model);
}
