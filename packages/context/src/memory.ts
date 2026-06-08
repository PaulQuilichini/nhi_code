import type { Message } from "@nhicode/shared";

const MAX_MEMORY_CHARS = 16_000;
const MAX_FIELD_CHARS = 1_600;
const MAX_NOTE_CHARS = 800;
const MAX_RECENT_ITEMS = 6;
const MAX_TOOL_ITEMS = 12;

export interface MemoryEvent {
  type: string;
  status?: string;
  message?: string;
  detail?: Record<string, unknown>;
}

export function buildThreadMemory(messages: Message[], events: MemoryEvent[] = []): string {
  const users = messages.filter((msg) => msg.role === "user" && text(msg));
  const assistants = messages.filter((msg) => msg.role === "assistant" && text(msg));
  const toolFacts = extractToolFacts(messages);
  const failures = extractFailures(events);

  const sections: string[] = [];
  const goal = users[0] ? text(users[0]) : "";
  if (goal) sections.push(section("Original Goal", goal, MAX_FIELD_CHARS));

  const latestUser = users.at(-1);
  if (latestUser && latestUser !== users[0]) {
    sections.push(section("Latest User Request", text(latestUser), MAX_FIELD_CHARS));
  }

  const recentAssistantNotes = assistants
    .slice(-MAX_RECENT_ITEMS)
    .map((msg) => cleanNote(text(msg)))
    .filter(Boolean);
  if (recentAssistantNotes.length) {
    sections.push(listSection("Recent Agent Notes", recentAssistantNotes));
  }

  if (toolFacts.files.length) {
    sections.push(listSection("Relevant Files", toolFacts.files.slice(-MAX_TOOL_ITEMS)));
  }

  if (toolFacts.commands.length) {
    sections.push(listSection("Recent Commands", toolFacts.commands.slice(-MAX_TOOL_ITEMS)));
  }

  if (failures.length) {
    sections.push(listSection("Recent Failures", failures.slice(-MAX_RECENT_ITEMS)));
  }

  const memory = sections.join("\n\n").trim();
  return memory.length > MAX_MEMORY_CHARS
    ? memory.slice(0, MAX_MEMORY_CHARS) + "\n\n[Working memory truncated.]"
    : memory;
}

function extractToolFacts(messages: Message[]): { files: string[]; commands: string[] } {
  const files = new Set<string>();
  const commands: string[] = [];

  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    for (const call of msg.tool_calls ?? []) {
      const args = parseJsonObject(call.function.arguments);
      if (!args) continue;

      for (const key of ["path", "file", "filePath", "filepath", "target", "cwd"]) {
        const value = args[key];
        if (typeof value === "string" && looksLikePath(value)) files.add(value);
      }

      if (call.function.name === "shell" || call.function.name === "shell_command") {
        const command = args.command;
        if (typeof command === "string" && command.trim()) {
          commands.push(truncate(command.trim(), MAX_NOTE_CHARS));
        }
      }
    }
  }

  return { files: Array.from(files), commands };
}

function extractFailures(events: MemoryEvent[]): string[] {
  return events
    .filter((event) => event.status === "error" || event.type === "error")
    .map((event) => event.message?.trim())
    .filter((message): message is string => Boolean(message))
    .map((message) => truncate(message, MAX_NOTE_CHARS));
}

function section(title: string, value: string, maxChars: number): string {
  return `### ${title}\n${truncate(cleanNote(value), maxChars)}`;
}

function listSection(title: string, values: string[]): string {
  const unique = Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
  return `### ${title}\n${unique.map((value) => `- ${truncate(value, MAX_NOTE_CHARS)}`).join("\n")}`;
}

function text(message: Message): string {
  return message.content?.trim() ?? "";
}

function cleanNote(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return value.slice(0, maxChars).trimEnd() + " ...";
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function looksLikePath(value: string): boolean {
  return /[\\/]/.test(value) || /\.[a-z0-9]{1,8}$/i.test(value);
}
