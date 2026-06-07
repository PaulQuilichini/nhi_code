import { useState } from "react";

interface ThinkingBlockProps {
  content: string;
  isStreaming?: boolean;
  defaultCollapsed?: boolean;
}

export function ThinkingBlock({ content, isStreaming, defaultCollapsed = true }: ThinkingBlockProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed && !isStreaming);

  if (!content && !isStreaming) return null;

  return (
    <div className={`thinking-block ${collapsed ? "collapsed" : ""}`}>
      <button
        type="button"
        className="thinking-header"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
      >
        <span className="thinking-chevron">{collapsed ? "▸" : "▾"}</span>
        <span className="thinking-title">
          {isStreaming ? "Thinking…" : "Thought process"}
        </span>
        {isStreaming && <span className="tool-spinner" />}
      </button>
      {!collapsed && (
        <div className="thinking-body">
          {content}
          {isStreaming && <span className="cursor-blink">▍</span>}
        </div>
      )}
    </div>
  );
}
