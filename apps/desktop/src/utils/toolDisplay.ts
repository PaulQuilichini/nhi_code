export interface ToolDisplayInfo {
  icon: string;
  label: string;
  summary: string;
  detail?: string;
  diff?: { path?: string; oldText: string; newText: string };
}

function truncate(text: string, max = 80): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

function parseArgs(argsJson: string): Record<string, unknown> {
  try {
    return JSON.parse(argsJson) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const TOOL_META: Record<string, { icon: string; label: string }> = {
  read_file: { icon: "📄", label: "Read" },
  write_file: { icon: "✎", label: "Write" },
  edit_file: { icon: "✎", label: "Edit" },
  glob: { icon: "🔍", label: "Glob" },
  grep: { icon: "🔍", label: "Grep" },
  list_dir: { icon: "📁", label: "List" },
  shell: { icon: "▶", label: "Shell" },
  git_status: { icon: "⎇", label: "Git status" },
  git_diff: { icon: "⎇", label: "Git diff" },
  git_commit: { icon: "⎇", label: "Git commit" },
  spawn_subagent: { icon: "◆", label: "Sub-agent" },
};

export function getToolDisplay(name: string, argsJson: string): ToolDisplayInfo {
  const meta = TOOL_META[name] ?? { icon: "⚙", label: name.replace(/_/g, " ") };
  const args = parseArgs(argsJson);

  switch (name) {
    case "read_file":
      return {
        ...meta,
        summary: String(args.path ?? "file"),
        detail: args.offset || args.limit ? `lines ${args.offset ?? 1}${args.limit ? `–${Number(args.offset ?? 1) + Number(args.limit) - 1}` : "+"}` : undefined,
      };
    case "write_file":
      return {
        ...meta,
        summary: String(args.path ?? "file"),
        detail: args.content ? `${String(args.content).length} chars` : undefined,
      };
    case "edit_file":
      return {
        ...meta,
        summary: String(args.path ?? "file"),
        diff: {
          path: args.path as string | undefined,
          oldText: String(args.old_string ?? ""),
          newText: String(args.new_string ?? ""),
        },
      };
    case "glob":
      return { ...meta, summary: String(args.pattern ?? "*") };
    case "grep":
      return {
        ...meta,
        summary: `"${truncate(String(args.pattern ?? ""), 40)}"`,
        detail: args.path ? `in ${args.path}` : undefined,
      };
    case "list_dir":
      return { ...meta, summary: String(args.path ?? ".") };
    case "shell":
      return { ...meta, summary: truncate(String(args.command ?? ""), 100) };
    case "git_status":
      return { ...meta, summary: "workspace" };
    case "git_diff":
      return { ...meta, summary: args.path ? String(args.path) : "workspace" };
    case "git_commit":
      return { ...meta, summary: truncate(String(args.message ?? ""), 60) };
    case "spawn_subagent":
      return {
        ...meta,
        summary: `${args.profile ?? "agent"}: ${truncate(String(args.task ?? ""), 60)}`,
      };
    default:
      return { ...meta, summary: truncate(argsJson, 80) };
  }
}

export function formatToolResult(name: string, content: string, isError?: boolean): string {
  if (isError) return content;
  if (name === "read_file") {
    const lines = content.split("\n").length;
    return `${lines} line${lines === 1 ? "" : "s"} read`;
  }
  if (name === "grep" || name === "glob") {
    const count = content === "(no matches)" ? 0 : content.split("\n").filter(Boolean).length;
    return count === 0 ? "No matches" : `${count} match${count === 1 ? "" : "es"}`;
  }
  if (name === "shell") {
    const lines = content.split("\n").length;
    return lines > 3 ? `${lines} lines of output` : truncate(content, 120);
  }
  if (name === "git_diff" && content.includes("@@")) {
    const hunks = (content.match(/^@@/gm) ?? []).length;
    return `${hunks} hunk${hunks === 1 ? "" : "s"}`;
  }
  return truncate(content, 120);
}
