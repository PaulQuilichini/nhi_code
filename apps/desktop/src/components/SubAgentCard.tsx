import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import type { SubAgentMessage, ToolMessage } from "../chatTypes";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolCallCard, ToolCallGroup } from "./ToolCallCard";
import { SUBAGENT_PROFILE_LABEL } from "../utils/subagentStream";

interface SubAgentCardProps {
  subagent: SubAgentMessage;
}

function taskPreview(task: string, max = 80): string {
  const oneLine = task.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1)}…`;
}

export function SubAgentCard({ subagent }: SubAgentCardProps) {
  const [expanded, setExpanded] = useState(subagent.status === "running");
  const profileLabel =
    SUBAGENT_PROFILE_LABEL[subagent.profile] ??
    subagent.profile.charAt(0).toUpperCase() + subagent.profile.slice(1);

  useEffect(() => {
    if (subagent.status === "running") setExpanded(true);
  }, [subagent.status]);

  const thinking = subagent.items.find((m) => m.role === "thinking");
  const tools = subagent.items.filter((m) => m.role === "tool") as ToolMessage[];
  const assistantParts = subagent.items.filter((m) => m.role === "assistant");
  const isNestedStreaming = subagent.items.some(
    (m) => (m.role === "assistant" || m.role === "thinking") && m.isStreaming,
  );

  return (
    <div
      className={`subagent-card status-${subagent.status} ${subagent.status === "error" ? "is-error" : ""}`}
    >
      <button
        type="button"
        className="subagent-card-header"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
      >
        <span className="subagent-icon">◆</span>
        <span className="subagent-label">{profileLabel}</span>
        <span className="subagent-task">{taskPreview(subagent.task)}</span>
        {subagent.status === "running" && <span className="tool-spinner" />}
        {subagent.status === "done" && <span className="tool-status-icon done">✓</span>}
        {subagent.status === "error" && <span className="tool-status-icon error">✕</span>}
        <span className="tool-chevron">{expanded ? "▾" : "▸"}</span>
      </button>

      {expanded && (
        <div className="subagent-card-body">
          {subagent.task && (
            <div className="subagent-task-full">{subagent.task}</div>
          )}

          {thinking && (
            <ThinkingBlock
              content={thinking.content}
              isStreaming={thinking.isStreaming}
              defaultCollapsed={!thinking.isStreaming}
            />
          )}

          {tools.length > 0 && (
            <div className="tool-stack subagent-nested-tools">
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
              className={`message message-assistant subagent-nested-assistant ${msg.isError ? "message-error" : ""}`}
            >
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

          {subagent.status === "running" && subagent.items.length === 0 && (
            <div className="subagent-running-hint">Starting sub-agent…</div>
          )}

          {subagent.status === "running" && isNestedStreaming && subagent.items.length > 0 && (
            <div className="subagent-running-hint">Sub-agent working…</div>
          )}

          {subagent.status !== "running" && subagent.result && assistantParts.length === 0 && (
            <pre className="tool-output subagent-result">{subagent.result}</pre>
          )}
        </div>
      )}
    </div>
  );
}
