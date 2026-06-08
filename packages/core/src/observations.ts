import type { Message, ObservationKind, ObservationRecord, ToolCall, ToolResult } from "@nhicode/shared";

const INLINE_CONTENT_CHARS = 4_000;
const COMPACT_HEAD_CHARS = 1_800;
const COMPACT_TAIL_CHARS = 1_400;
const MAX_EXPAND_CHARS = 80_000;

export type NewObservation = Omit<ObservationRecord, "id" | "createdAt">;

export function createObservationInput(
  threadId: string,
  call: ToolCall,
  args: Record<string, unknown>,
  result: ToolResult,
): NewObservation {
  const content = result.content ?? "";
  const kind = observationKind(call.function.name);
  const summary = summarizeObservation(kind, call.function.name, args, content, result.isError);
  const compactContent = compactObservation(kind, call.function.name, args, content, result.isError);

  return {
    threadId,
    toolCallId: call.id,
    toolName: call.function.name,
    kind,
    summary,
    content,
    compactContent,
    isError: result.isError,
    metadata: observationMetadata(args, content),
    tokenEstimate: estimateTokens(compactContent),
    rawTokenEstimate: estimateTokens(content),
  };
}

export function observationToolMessage(observation: ObservationRecord): Message {
  return {
    role: "tool",
    name: observation.toolName,
    tool_call_id: observation.toolCallId,
    content: [
      `Observation ${observation.id} stored for ${observation.toolName}${observation.isError ? " (error)" : ""}.`,
      `Summary: ${observation.summary}`,
      "",
      observation.compactContent,
      "",
      `Raw output is ~${observation.rawTokenEstimate} tokens. Use expand_observation with id "${observation.id}" for exact output when needed.`,
    ].join("\n"),
  };
}

export function expandedObservationContent(
  observation: ObservationRecord,
  maxChars = MAX_EXPAND_CHARS,
): string {
  const limit = Math.max(1, Math.min(maxChars, MAX_EXPAND_CHARS));
  const body =
    observation.content.length > limit
      ? `${observation.content.slice(0, limit).trimEnd()}\n\n[expand_observation truncated at ${limit} characters of ${observation.content.length}]`
      : observation.content;

  return [
    `Observation ${observation.id}`,
    `Tool: ${observation.toolName}`,
    `Summary: ${observation.summary}`,
    "",
    body || "(empty output)",
  ].join("\n");
}

function observationKind(toolName: string): ObservationKind {
  if (toolName === "read_file") return "file_read";
  if (toolName === "write_file") return "file_write";
  if (toolName === "edit_file") return "file_edit";
  if (toolName === "grep" || toolName === "glob" || toolName === "list_dir") return "search";
  if (toolName === "shell") return "shell";
  if (toolName.startsWith("git_")) return "git";
  if (toolName === "spawn_subagent") return "subagent";
  return "other";
}

function summarizeObservation(
  kind: ObservationKind,
  toolName: string,
  args: Record<string, unknown>,
  content: string,
  isError?: boolean,
): string {
  if (isError) return `${toolName} failed: ${oneLine(content, 180)}`;
  switch (kind) {
    case "file_read":
      return `Read ${args.path ?? "file"} (${lineCount(content)} lines shown)`;
    case "file_write":
      return oneLine(content, 180) || `Wrote ${args.path ?? "file"}`;
    case "file_edit":
      return oneLine(content, 180) || `Edited ${args.path ?? "file"}`;
    case "search":
      return `${toolName} returned ${content === "(no matches)" ? 0 : nonEmptyLines(content).length} item(s)`;
    case "shell":
      return `Command output (${lineCount(content)} lines): ${oneLine(content, 180) || "(no output)"}`;
    case "git":
      return `${toolName}: ${oneLine(content, 180) || "(no output)"}`;
    case "subagent":
      return `Sub-agent result: ${oneLine(content, 180) || "(empty)"}`;
    default:
      return `${toolName}: ${oneLine(content, 180) || "(empty)"}`;
  }
}

function compactObservation(
  kind: ObservationKind,
  toolName: string,
  args: Record<string, unknown>,
  content: string,
  isError?: boolean,
): string {
  const header = compactHeader(kind, toolName, args, content, isError);
  if (content.length <= INLINE_CONTENT_CHARS) {
    return `${header}\n${content || "(no output)"}`;
  }
  const omitted = content.length - COMPACT_HEAD_CHARS - COMPACT_TAIL_CHARS;
  return [
    header,
    content.slice(0, COMPACT_HEAD_CHARS).trimEnd(),
    "",
    `[... ${Math.max(0, omitted)} characters omitted from compact observation ...]`,
    "",
    content.slice(-COMPACT_TAIL_CHARS).trimStart(),
  ].join("\n");
}

function compactHeader(
  kind: ObservationKind,
  toolName: string,
  args: Record<string, unknown>,
  content: string,
  isError?: boolean,
): string {
  const status = isError ? "error" : "ok";
  if (kind === "file_read") {
    const range = args.offset || args.limit ? ` lines ${args.offset ?? 1}+${args.limit ?? ""}` : "";
    return `[${status}] ${toolName}: ${args.path ?? "file"}${range} (${lineCount(content)} lines compacted)`;
  }
  if (kind === "shell") {
    const command = typeof args.command === "string" ? args.command : `[${args.interpreter ?? "script"} script]`;
    return `[${status}] ${toolName}: ${oneLine(command, 240)} (${lineCount(content)} output lines compacted)`;
  }
  return `[${status}] ${toolName} (${lineCount(content)} lines compacted)`;
}

function observationMetadata(args: Record<string, unknown>, content: string): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    contentLength: content.length,
    lineCount: lineCount(content),
  };
  for (const key of ["path", "pattern", "glob", "command", "shell", "interpreter", "offset", "limit"]) {
    const value = args[key];
    if (typeof value === "string" || typeof value === "number") metadata[key] = value;
  }
  return metadata;
}

function estimateTokens(value: string): number {
  return Math.ceil(value.length / 4);
}

function lineCount(value: string): number {
  if (!value) return 0;
  return value.split("\n").length;
}

function nonEmptyLines(value: string): string[] {
  return value.split("\n").filter((line) => line.trim());
}

function oneLine(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}
