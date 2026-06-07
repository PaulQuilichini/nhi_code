import { useState } from "react";
import { getToolDisplay, formatToolResult } from "../utils/toolDisplay";

export interface ToolCallMessage {
  id: string;
  toolCallId: string;
  toolName: string;
  args: string;
  result?: string;
  status: "running" | "done" | "error";
  isError?: boolean;
}

interface ToolCallCardProps {
  tool: ToolCallMessage;
}

export function ToolCallCard({ tool }: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(false);
  const display = getToolDisplay(tool.toolName, tool.args);
  const resultSummary =
    tool.result !== undefined
      ? formatToolResult(tool.toolName, tool.result, tool.isError)
      : undefined;

  return (
    <div className={`tool-card status-${tool.status} ${tool.isError ? "is-error" : ""}`}>
      <button
        type="button"
        className="tool-card-header"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
      >
        <span className="tool-icon">{display.icon}</span>
        <span className="tool-label">{display.label}</span>
        <span className="tool-summary">{display.summary}</span>
        {tool.status === "running" && <span className="tool-spinner" />}
        {tool.status === "done" && !tool.isError && (
          <span className="tool-status-icon done">✓</span>
        )}
        {tool.isError && <span className="tool-status-icon error">✕</span>}
        {resultSummary && tool.status !== "running" && (
          <span className="tool-result-preview">{resultSummary}</span>
        )}
        <span className="tool-chevron">{expanded ? "▾" : "▸"}</span>
      </button>

      {expanded && (
        <div className="tool-card-body">
          {display.diff && (display.diff.oldText || display.diff.newText) && (
            <div className="diff-view">
              {display.diff.oldText && (
                <div className="diff-chunk diff-remove">
                  {display.diff.oldText.split("\n").map((line, i) => (
                    <div key={`o-${i}`} className="diff-line">
                      <span className="diff-gutter">−</span>
                      {line || " "}
                    </div>
                  ))}
                </div>
              )}
              {display.diff.newText && (
                <div className="diff-chunk diff-add">
                  {display.diff.newText.split("\n").map((line, i) => (
                    <div key={`n-${i}`} className="diff-line">
                      <span className="diff-gutter">+</span>
                      {line || " "}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {display.detail && (
            <div className="tool-detail">{display.detail}</div>
          )}

          {tool.result !== undefined && (
            <pre className="tool-output">{tool.result}</pre>
          )}

          {tool.status === "running" && !tool.result && (
            <div className="tool-running-hint">Running…</div>
          )}
        </div>
      )}
    </div>
  );
}
