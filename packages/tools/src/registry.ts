import { readFile, writeFile, readdir, mkdir, mkdtemp, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { relative, resolve, dirname, isAbsolute, join } from "node:path";
import fg from "fast-glob";
import type { ToolDefinition, ToolResult } from "@nhicode/shared";

const execFileAsync = promisify(execFile);
const DEFAULT_SHELL_TIMEOUT_MS = 120_000;
const MAX_COMMAND_OUTPUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_READ_LIMIT = 200;
const MAX_READ_LIMIT = 2_000;

export interface ToolContext {
  cwd: string;
  sessionId: string;
  toolCallId?: string;
  spawnSubAgent?: (profile: string, task: string, toolCallId: string) => Promise<string>;
}

export interface ToolHandler {
  definition: ToolDefinition;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

function resolvePath(cwd: string, p: string): string {
  if (resolve(p) === p || p.startsWith("/") || /^[A-Za-z]:/.test(p)) {
    return resolve(p);
  }
  return resolve(cwd, p);
}

function isWithinWorkspace(cwd: string, targetPath: string): boolean {
  const rel = relative(resolve(cwd), resolve(targetPath));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function assertWritableInWorkspace(cwd: string, targetPath: string): void {
  if (!isWithinWorkspace(cwd, targetPath)) {
    throw new Error(`Writes outside the workspace are blocked: ${targetPath}`);
  }
}

function assertSafeShellCommand(command: string): void {
  const normalized = command.trim().toLowerCase();
  const dangerous = [
    /\brm\s+-[^\r\n]*r[^\r\n]*f\b/,
    /\brm\s+-[^\r\n]*f[^\r\n]*r\b/,
    /\brmdir\s+\/s\b/,
    /\bdel\s+\/[^\r\n]*[sq][^\r\n]*\b/,
    /\bformat(?:\.com)?\b/,
    /\bdiskpart\b/,
    /\bshutdown\b/,
    /\bpowershell(?:\.exe)?\b[^\r\n]*-encodedcommand\b/,
  ];
  if (dangerous.some((pattern) => pattern.test(normalized))) {
    throw new Error("Potentially destructive shell command blocked");
  }
}

export const toolDefinitions: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a bounded range from a file at the given path. Defaults to 200 lines; pass offset and limit to inspect specific ranges.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to workspace or absolute" },
          offset: { type: "number", description: "Line number to start reading from (1-indexed)" },
          limit: { type: "number", description: "Maximum number of lines to read" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write content to a file, creating directories as needed",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path" },
          content: { type: "string", description: "Content to write" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Replace a unique string in a file with new content",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path" },
          old_string: { type: "string", description: "Exact string to find and replace" },
          new_string: { type: "string", description: "Replacement string" },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "glob",
      description: "Find files matching a glob pattern",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob pattern e.g. '**/*.ts'" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description: "Search for a regex pattern in files",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regex pattern to search for" },
          path: { type: "string", description: "Directory or file to search in", default: "." },
          glob: { type: "string", description: "File glob filter e.g. '*.ts'" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List files and directories at a path",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path", default: "." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "shell",
      description: "Execute a shell command or transient script in the workspace directory. Use command for shell commands. Use script with an interpreter for temporary multi-line code instead of node -e, python -c, heredocs, echo, or redirection.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to execute" },
          shell: {
            type: "string",
            enum: ["auto", "powershell", "cmd", "sh"],
            description: "Shell used for command execution",
            default: "auto",
          },
          script: { type: "string", description: "Temporary script source to run from a file" },
          interpreter: {
            type: "string",
            enum: ["node", "python", "powershell", "sh"],
            description: "Interpreter for script",
          },
          timeoutSeconds: {
            type: "number",
            description: "Maximum command or script runtime in seconds",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_status",
      description: "Get git status of the workspace",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "git_diff",
      description: "Get git diff for the workspace or a specific file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Optional file path to diff" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_commit",
      description: "Create a git commit from already staged changes",
      parameters: {
        type: "object",
        properties: {
          message: { type: "string", description: "Commit message" },
        },
        required: ["message"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "spawn_subagent",
      description: "Spawn a specialized sub-agent to handle a delegated task. Profiles: explorer (read-only search), implementer (write code), reviewer (review diffs)",
      parameters: {
        type: "object",
        properties: {
          profile: {
            type: "string",
            enum: ["explorer", "implementer", "reviewer"],
            description: "Sub-agent profile to use",
          },
          task: { type: "string", description: "Task description for the sub-agent" },
        },
        required: ["profile", "task"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "expand_observation",
      description: "Fetch exact raw output for a stored tool observation only when the compact summary is insufficient.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Observation id, for example obs_12_abcd1234" },
          maxChars: { type: "number", description: "Maximum raw characters to return" },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "promote_context",
      description: "Promote a concise durable fact into working memory for future turns.",
      parameters: {
        type: "object",
        properties: {
          note: { type: "string", description: "Concise fact, decision, file path, or next step to remember" },
        },
        required: ["note"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "drop_context",
      description: "Remove stale or incorrect text from working memory.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "Exact or approximate working-memory text to remove" },
        },
        required: ["text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "summarize_phase",
      description: "Replace working memory with a concise phase summary after a major task phase completes.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "Concise current state, decisions made, and next action" },
        },
        required: ["summary"],
      },
    },
  },
];

/** Session-level context tools — handled in-session, safe in every mode. */
const CONTEXT_TOOL_NAMES = new Set([
  "expand_observation",
  "promote_context",
  "drop_context",
  "summarize_phase",
]);

export interface ToolDefinitionFilter {
  allowedTools?: readonly string[];
  deniedTools?: readonly string[];
}

export class ToolRegistry {
  private handlers: Map<string, ToolHandler["execute"]> = new Map();
  private shellTimeoutMs = DEFAULT_SHELL_TIMEOUT_MS;

  constructor() {
    this.registerDefaults();
  }

  private registerDefaults(): void {
    this.handlers.set("read_file", readFileTool);
    this.handlers.set("write_file", writeFileTool);
    this.handlers.set("edit_file", editFileTool);
    this.handlers.set("glob", globTool);
    this.handlers.set("grep", grepTool);
    this.handlers.set("list_dir", listDirTool);
    this.handlers.set("shell", (args, ctx) => shellTool(args, ctx, this.shellTimeoutMs));
    this.handlers.set("git_status", gitStatusTool);
    this.handlers.set("git_diff", gitDiffTool);
    this.handlers.set("git_commit", gitCommitTool);
    this.handlers.set("spawn_subagent", spawnSubagentTool);
  }

  getDefinitions(filter?: ToolDefinitionFilter): ToolDefinition[] {
    const allowed = filter?.allowedTools ? new Set(filter.allowedTools) : null;
    const denied = new Set(filter?.deniedTools ?? []);
    if (!allowed && denied.size === 0) return toolDefinitions;

    return toolDefinitions.filter((def) => {
      const name = def.function.name;
      if (CONTEXT_TOOL_NAMES.has(name)) return true;
      if (denied.has(name)) return false;
      if (allowed && !allowed.has(name)) return false;
      return true;
    });
  }

  setShellTimeoutMs(timeoutMs: number): void {
    this.shellTimeoutMs = Math.max(1, timeoutMs);
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const handler = this.handlers.get(name);
    if (!handler) {
      return {
        toolCallId: "",
        name,
        content: `Unknown tool: ${name}`,
        isError: true,
      };
    }
    try {
      const content = await handler(args, ctx);
      return { toolCallId: "", name, content };
    } catch (err) {
      return {
        toolCallId: "",
        name,
        content: `Error: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  }
}

async function readFileTool(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const filePath = resolvePath(ctx.cwd, args.path as string);
  const content = await readFile(filePath, "utf-8");
  const lines = content.split("\n");
  const offset = (args.offset as number) ?? 1;
  const requestedLimit = (args.limit as number) ?? DEFAULT_READ_LIMIT;
  const limit = Math.min(Math.max(1, requestedLimit), MAX_READ_LIMIT);
  const slice = lines.slice(offset - 1, offset - 1 + limit);
  const rendered = slice.map((line, i) => `${offset + i}|${line}`).join("\n");
  const end = offset + slice.length - 1;
  const note =
    end < lines.length
      ? `\n[read_file truncated: showing lines ${offset}-${end} of ${lines.length}. Request offset=${end + 1} with a limit to continue.]`
      : "";
  return rendered + note;
}

async function writeFileTool(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const filePath = resolvePath(ctx.cwd, args.path as string);
  assertWritableInWorkspace(ctx.cwd, filePath);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, args.content as string, "utf-8");
  return `Wrote ${relative(ctx.cwd, filePath)} (${(args.content as string).length} bytes)`;
}

async function editFileTool(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const filePath = resolvePath(ctx.cwd, args.path as string);
  assertWritableInWorkspace(ctx.cwd, filePath);
  const content = await readFile(filePath, "utf-8");
  const oldStr = args.old_string as string;
  const newStr = args.new_string as string;
  if (!content.includes(oldStr)) {
    throw new Error(`String not found in ${args.path}`);
  }
  const count = content.split(oldStr).length - 1;
  if (count > 1) {
    throw new Error(`String appears ${count} times — must be unique`);
  }
  await writeFile(filePath, content.replace(oldStr, newStr), "utf-8");
  return `Edited ${relative(ctx.cwd, filePath)}`;
}

async function globTool(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const files = await fg(args.pattern as string, {
    cwd: ctx.cwd,
    absolute: false,
    ignore: ["**/node_modules/**", "**/.git/**"],
  });
  return files.slice(0, 200).join("\n") || "(no matches)";
}

async function grepTool(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const searchPath = resolvePath(ctx.cwd, (args.path as string) ?? ".");
  const pattern = args.pattern as string;
  const globFilter = (args.glob as string) ?? "**/*";

  const files = await fg(globFilter, {
    cwd: searchPath,
    absolute: true,
    ignore: ["**/node_modules/**", "**/.git/**"],
    onlyFiles: true,
  });

  const regex = new RegExp(pattern, "gi");
  const results: string[] = [];

  for (const file of files.slice(0, 100)) {
    try {
      const content = await readFile(file, "utf-8");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          results.push(`${relative(ctx.cwd, file)}:${i + 1}:${lines[i].trim()}`);
          regex.lastIndex = 0;
        }
        if (results.length >= 50) break;
      }
    } catch {
      // skip binary/unreadable
    }
    if (results.length >= 50) break;
  }

  return results.join("\n") || "(no matches)";
}

async function listDirTool(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const dirPath = resolvePath(ctx.cwd, (args.path as string) ?? ".");
  const entries = await readdir(dirPath, { withFileTypes: true });
  return entries
    .map((e) => `${e.isDirectory() ? "d" : "f"} ${e.name}`)
    .sort()
    .join("\n");
}

async function shellTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
  defaultTimeoutMs: number,
): Promise<string> {
  const timeoutMs = timeoutMsFromArgs(args, defaultTimeoutMs);
  const command = typeof args.command === "string" ? args.command : "";
  const script = typeof args.script === "string" ? args.script : "";

  if (script) {
    assertSafeShellCommand(script);
    const interpreter = args.interpreter as ScriptInterpreter | undefined;
    if (!interpreter) {
      throw new Error("Shell script execution requires an interpreter");
    }
    return runTransientScript(script, interpreter, ctx.cwd, timeoutMs);
  }

  if (!command) {
    throw new Error("Shell execution requires command or script");
  }

  assertSafeShellCommand(command);
  return runShellCommand(command, (args.shell as ShellMode | undefined) ?? "auto", ctx.cwd, timeoutMs);
}

type ShellMode = "auto" | "powershell" | "cmd" | "sh";
type ScriptInterpreter = "node" | "python" | "powershell" | "sh";

async function runShellCommand(
  command: string,
  shell: ShellMode,
  cwd: string,
  timeoutMs: number,
): Promise<string> {
  if (process.platform === "win32") {
    if (shell === "cmd") {
      return withTempScript(".cmd", cmdScript(command), false, (file) =>
        runExecFile("cmd.exe", ["/d", "/s", "/c", quoteWindowsPath(file)], cwd, timeoutMs),
      );
    }
    if (shell === "sh") {
      return withTempScript(".sh", command, false, (file) =>
        runExecFile("sh", [file], cwd, timeoutMs),
      );
    }

    const runPowerShell = () =>
      withTempScript(".ps1", powershellScript(command), true, (file) =>
        runFirstAvailable(
          [
            { file: "pwsh", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file] },
            { file: "powershell", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file] },
          ],
          cwd,
          timeoutMs,
        ),
      );

    if (shell === "powershell") return runPowerShell();
    try {
      return await runPowerShell();
    } catch (err) {
      if (!isExecutableMissing(err)) throw err;
      return withTempScript(".cmd", cmdScript(command), false, (file) =>
        runExecFile("cmd.exe", ["/d", "/s", "/c", quoteWindowsPath(file)], cwd, timeoutMs),
      );
    }
  }

  if (shell === "powershell") {
    return withTempScript(".ps1", powershellScript(command), true, (file) =>
      runFirstAvailable(
        [
          { file: "pwsh", args: ["-NoProfile", "-File", file] },
          { file: "powershell", args: ["-NoProfile", "-File", file] },
        ],
        cwd,
        timeoutMs,
      ),
    );
  }

  return withTempScript(".sh", command, false, (file) =>
    runExecFile("sh", [file], cwd, timeoutMs),
  );
}

async function runTransientScript(
  script: string,
  interpreter: ScriptInterpreter,
  cwd: string,
  timeoutMs: number,
): Promise<string> {
  switch (interpreter) {
    case "node":
      return withTempScript(".mjs", script, false, (file) =>
        runExecFile(process.execPath || "node", [file], cwd, timeoutMs),
      );
    case "python":
      return withTempScript(".py", script, false, (file) =>
        runFirstAvailable(
          [
            { file: process.platform === "win32" ? "py" : "python3", args: [file] },
            { file: "python", args: [file] },
            { file: "python3", args: [file] },
          ],
          cwd,
          timeoutMs,
        ),
      );
    case "powershell":
      return withTempScript(".ps1", powershellScript(script), true, (file) =>
        runFirstAvailable(
          [
            { file: "pwsh", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file] },
            { file: "powershell", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file] },
          ],
          cwd,
          timeoutMs,
        ),
      );
    case "sh":
      return withTempScript(".sh", script, false, (file) =>
        runExecFile("sh", [file], cwd, timeoutMs),
      );
  }
}

async function withTempScript(
  extension: string,
  content: string,
  utf8Bom: boolean,
  run: (file: string) => Promise<string>,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "nhicode-tool-"));
  const file = join(dir, `script${extension}`);
  try {
    await writeFile(file, utf8Bom ? `\uFEFF${content}` : content, "utf-8");
    return await run(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runFirstAvailable(
  candidates: Array<{ file: string; args: string[] }>,
  cwd: string,
  timeoutMs: number,
): Promise<string> {
  let missingError: unknown;
  for (const candidate of candidates) {
    try {
      return await runExecFile(candidate.file, candidate.args, cwd, timeoutMs);
    } catch (err) {
      if (!isExecutableMissing(err)) throw err;
      missingError = err;
    }
  }
  throw missingError ?? new Error("No matching interpreter was found");
}

async function runExecFile(
  file: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
      windowsHide: true,
    });
    return formatCommandOutput(stdout, stderr);
  } catch (err) {
    if (isTimeoutError(err)) {
      throw new Error(`Shell command exceeded the maximum runtime of ${Math.round(timeoutMs / 1000)} seconds.`);
    }
    throw err;
  }
}

function timeoutMsFromArgs(args: Record<string, unknown>, defaultTimeoutMs: number): number {
  const seconds = args.timeoutSeconds;
  if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0) {
    return Math.round(seconds * 1000);
  }
  return defaultTimeoutMs;
}

function cmdScript(command: string): string {
  return `@echo off\r\nchcp 65001 >nul\r\n${command}`;
}

function powershellScript(command: string): string {
  return [
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()",
    "$OutputEncoding = [System.Text.UTF8Encoding]::new()",
    command,
  ].join("\r\n");
}

function quoteWindowsPath(path: string): string {
  return `"${path.replace(/"/g, '""')}"`;
}

function formatCommandOutput(stdout: string, stderr: string): string {
  const output = [stdout, stderr].filter(Boolean).join("\n").trim();
  return output || "(no output)";
}

function isExecutableMissing(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  return code === "ENOENT";
}

function isTimeoutError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const value = err as { killed?: unknown; signal?: unknown; message?: unknown };
  return (
    value.killed === true ||
    value.signal === "SIGTERM" ||
    (typeof value.message === "string" && value.message.toLowerCase().includes("timed out"))
  );
}

async function gitTool(args: string[], ctx: ToolContext): Promise<string> {
  const { stdout, stderr } = await execFileAsync("git", args, {
    cwd: ctx.cwd,
    timeout: 30_000,
  });
  return (stdout || stderr).trim() || "(no output)";
}

async function gitStatusTool(_args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  return gitTool(["status", "--short", "--branch"], ctx);
}

async function gitDiffTool(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const gitArgs = ["diff"];
  if (args.path) gitArgs.push("--", args.path as string);
  return gitTool(gitArgs, ctx);
}

async function gitCommitTool(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  return gitTool(["commit", "-m", args.message as string], ctx);
}

async function spawnSubagentTool(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  if (!ctx.spawnSubAgent) {
    throw new Error("Sub-agent spawning is not available in this context");
  }
  if (!ctx.toolCallId) {
    throw new Error("Sub-agent spawn requires tool call context");
  }
  return ctx.spawnSubAgent(args.profile as string, args.task as string, ctx.toolCallId);
}

export { toolDefinitions as definitions };
