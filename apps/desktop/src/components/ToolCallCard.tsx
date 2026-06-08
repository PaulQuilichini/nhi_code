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
  observationId?: string;
  rawContentLength?: number;
  compacted?: boolean;
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
        {tool.observationId && (
          <span className="tool-observation-id" title="Raw output stored locally">
            {tool.observationId}
          </span>
        )}
        <span className="tool-chevron">{expanded ? "▾" : "▸"}</span>
      </button>

      {expanded && (
        <div className="tool-card-body">
          {tool.observationId && (
            <div className="tool-detail">
              Raw output stored as {tool.observationId}
              {tool.rawContentLength ? ` (${tool.rawContentLength} chars)` : ""}
            </div>
          )}
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

export function ToolCallGroup({ tools }: { tools: ToolCallMessage[] }) {
  const [expanded, setExpanded] = useState(false);
  const runningCount = tools.filter((tool) => tool.status === "running").length;
  const errorCount = tools.filter((tool) => tool.isError || tool.status === "error").length;
  const summary = summarizeToolGroup(tools);

  return (
    <div className={`tool-group ${expanded ? "is-expanded" : ""}`}>
      <button
        type="button"
        className="tool-group-header"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        <span className="tool-chevron">{expanded ? "▾" : "▸"}</span>
        <span className="tool-group-title">{tools.length} tool calls</span>
        <span className="tool-group-summary">{summary}</span>
        {runningCount > 0 && <span className="tool-spinner" />}
        {errorCount > 0 && <span className="tool-group-error">{errorCount} error{errorCount === 1 ? "" : "s"}</span>}
      </button>
      {expanded && (
        <div className="tool-group-body">
          {tools.map((tool) => (
            <ToolCallCard key={tool.id} tool={tool} />
          ))}
        </div>
      )}
    </div>
  );
}

function summarizeToolGroup(tools: ToolCallMessage[]): string {
  const counts = new Map<string, number>();
  for (const tool of tools) {
    counts.set(tool.toolName, (counts.get(tool.toolName) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 4)
    .map(([name, count]) => `${count} ${toolLabel(name, count)}`)
    .join(", ");
}

function toolLabel(name: string, count: number): string {
  const display = getToolDisplay(name, "{}");
  const label = display.label.toLocaleLowerCase();
  return count === 1 ? label : `${label}s`;
}
