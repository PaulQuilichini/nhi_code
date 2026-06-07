import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { relative, resolve, dirname } from "node:path";
import fg from "fast-glob";
import type { ToolDefinition, ToolResult } from "@nhicode/shared";

const execFileAsync = promisify(execFile);

export interface ToolContext {
  cwd: string;
  sessionId: string;
  spawnSubAgent?: (profile: string, task: string) => Promise<string>;
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

export const toolDefinitions: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the contents of a file at the given path",
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
      description: "Execute a shell command in the workspace directory",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Command to execute" },
        },
        required: ["command"],
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
      description: "Stage all changes and create a git commit",
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
];

export class ToolRegistry {
  private handlers: Map<string, ToolHandler["execute"]> = new Map();

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
    this.handlers.set("shell", shellTool);
    this.handlers.set("git_status", gitStatusTool);
    this.handlers.set("git_diff", gitDiffTool);
    this.handlers.set("git_commit", gitCommitTool);
    this.handlers.set("spawn_subagent", spawnSubagentTool);
  }

  getDefinitions(): ToolDefinition[] {
    return toolDefinitions;
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
  const limit = (args.limit as number) ?? lines.length;
  const slice = lines.slice(offset - 1, offset - 1 + limit);
  return slice.map((line, i) => `${offset + i}|${line}`).join("\n");
}

async function writeFileTool(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const filePath = resolvePath(ctx.cwd, args.path as string);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, args.content as string, "utf-8");
  return `Wrote ${relative(ctx.cwd, filePath)} (${(args.content as string).length} bytes)`;
}

async function editFileTool(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const filePath = resolvePath(ctx.cwd, args.path as string);
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

async function shellTool(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const command = args.command as string;
  const isWin = process.platform === "win32";
  const { stdout, stderr } = await execFileAsync(
    isWin ? "cmd.exe" : "sh",
    isWin ? ["/c", command] : ["-c", command],
    { cwd: ctx.cwd, timeout: 120_000, maxBuffer: 1024 * 1024 },
  );
  const output = [stdout, stderr].filter(Boolean).join("\n").trim();
  return output || "(no output)";
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
  await gitTool(["add", "-A"], ctx);
  return gitTool(["commit", "-m", args.message as string], ctx);
}

async function spawnSubagentTool(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  if (!ctx.spawnSubAgent) {
    throw new Error("Sub-agent spawning is not available in this context");
  }
  return ctx.spawnSubAgent(args.profile as string, args.task as string);
}

export { toolDefinitions as definitions };
