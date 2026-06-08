import { readFile, access } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Message } from "@nhicode/shared";
import { sanitizeMessageHistory, trimMessageHistory } from "./history.js";

const execFileAsync = promisify(execFile);
const PROJECT_DOC_MAX_BYTES = 32 * 1024;

const BASE_SYSTEM_PROMPT = `You are NHI Code, an expert AI coding agent. NHI stands for Non-Human Intelligence. You help developers write, debug, and understand code in local projects.

You have access to tools for reading/writing files, searching code, running shell commands, and git operations. Use them proactively to accomplish tasks.

Communication style (match Codex / Claude Code):
- Be concise and action-oriented. Lead with what you're doing, not long preambles.
- After tool use, summarize outcomes briefly — don't dump raw output unless asked.
- Use markdown for code blocks and file paths. Keep prose tight.
- When editing, explain the change in one or two sentences max unless the user wants detail.

Guidelines:
- Read relevant files before making changes
- Make minimal, focused edits
- When stuck, explore the codebase with grep/glob before guessing
- Prefer edit_file for surgical changes, write_file for new files`;

export interface ContextOptions {
  cwd: string;
  modeAddendum?: string;
  agentPrompt?: string;
  maxHistoryMessages?: number;
}

export class ContextBuilder {
  private systemPrompt: string | null = null;

  async buildSystemPrompt(options: ContextOptions): Promise<string> {
    if (this.systemPrompt) return this.systemPrompt;

    const parts = [BASE_SYSTEM_PROMPT];

    if (options.modeAddendum) {
      parts.push("\n\n" + options.modeAddendum);
    }

    if (options.agentPrompt) {
      parts.push("\n\n" + options.agentPrompt);
    }

    const agentsMd = await this.loadAgentsMd(options.cwd);
    if (agentsMd) {
      parts.push("\n\n## Project Instructions (AGENTS.md)\n\n" + agentsMd);
    }

    const gitContext = await this.loadGitContext(options.cwd);
    if (gitContext) {
      parts.push("\n\n## Git Status\n\n```\n" + gitContext + "\n```");
    }

    parts.push(`\n\n## Workspace\nWorking directory: ${options.cwd}`);

    this.systemPrompt = parts.join("");
    return this.systemPrompt;
  }

  buildMessages(
    systemPrompt: string,
    history: Message[],
    userMessage: string,
    maxHistory = 40,
  ): Message[] {
    const trimmed = trimMessageHistory(history, maxHistory);
    return [
      { role: "system", content: systemPrompt },
      ...trimmed,
      { role: "user", content: userMessage },
    ];
  }

  compactHistory(messages: Message[], maxMessages = 30): Message[] {
    if (messages.length <= maxMessages) return sanitizeMessageHistory(messages);

    const first = messages.find((m) => m.role === "user");
    const recent = trimMessageHistory(messages, maxMessages);
    if (first && !recent.includes(first)) {
      return [
        first,
        { role: "user", content: "[... earlier context truncated ...]" },
        ...recent.filter((m) => m !== first),
      ];
    }
    return recent;
  }

  private async loadAgentsMd(cwd: string): Promise<string | null> {
    const parts: string[] = [];
    let bytes = 0;

    const append = (content: string): void => {
      if (bytes >= PROJECT_DOC_MAX_BYTES) return;
      const remaining = PROJECT_DOC_MAX_BYTES - bytes;
      const next = Buffer.byteLength(content) > remaining ? content.slice(0, remaining) : content;
      parts.push(next);
      bytes += Buffer.byteLength(next);
    };

    const global = await this.readFirstInstruction([
      join(homedir(), ".nhicode", "AGENTS.override.md"),
      join(homedir(), ".nhicode", "AGENTS.md"),
    ]);
    if (global) append(global);

    const root = await this.findProjectRoot(cwd);
    for (const dir of instructionDirs(root, cwd)) {
      const local = await this.readFirstInstruction([
        join(dir, "AGENTS.override.md"),
        join(dir, "AGENTS.md"),
      ]);
      if (local) append(local);
    }

    return parts.length > 0 ? parts.join("\n\n") : null;
  }

  private async readFirstInstruction(paths: string[]): Promise<string | null> {
    for (const p of paths) {
      try {
        await access(p);
        const content = await readFile(p, "utf-8");
        if (content.trim()) return content;
      } catch {
        // not found
      }
    }
    return null;
  }

  private async findProjectRoot(cwd: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
        cwd,
        timeout: 5000,
      });
      return stdout.trim() || cwd;
    } catch {
      return cwd;
    }
  }

  private async loadGitContext(cwd: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync("git", ["status", "--short", "--branch"], {
        cwd,
        timeout: 5000,
      });
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  reset(): void {
    this.systemPrompt = null;
  }
}

function instructionDirs(root: string, cwd: string): string[] {
  const rootPath = resolve(root);
  const cwdPath = resolve(cwd);
  const rel = relative(rootPath, cwdPath);
  if (rel.startsWith("..")) return [cwdPath];
  if (!rel) return [rootPath];

  const dirs = [rootPath];
  let current = rootPath;
  for (const segment of rel.split(/[\\/]+/)) {
    current = join(current, segment);
    dirs.push(current);
  }
  return dirs;
}

export const AGENT_PROFILES: Record<string, { mode: string; systemPrompt: string; maxTurns: number }> = {
  explorer: {
    mode: "ask",
    maxTurns: 15,
    systemPrompt: `You are an Explorer sub-agent. Your job is to search and map the codebase.
Return a concise summary of: file structure, key modules, patterns found, and relevant files for the task.
Do NOT make any changes.`,
  },
  implementer: {
    mode: "agent",
    maxTurns: 25,
    systemPrompt: `You are an Implementer sub-agent. Your job is to write code for a specific scoped task.
Make the minimal changes needed. Return a summary of what you changed and why.`,
  },
  reviewer: {
    mode: "ask",
    maxTurns: 10,
    systemPrompt: `You are a Reviewer sub-agent. Review code changes for bugs, style issues, and missing edge cases.
Return a structured review with severity levels (critical/warning/info).`,
  },
};
