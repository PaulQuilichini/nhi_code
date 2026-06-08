import type {
  ApprovalCategory,
  ApprovalPolicy,
  ApprovalScope,
  ModeProfile,
  PolicyDecision,
  PolicyRule,
  ToolCall,
} from "@nhicode/shared";
import { TOOL_CATEGORY } from "@nhicode/shared";

export const MODE_PROFILES: Record<string, ModeProfile> = {
  plan: {
    name: "plan",
    description: "Analyze and design without making changes",
    sandbox: "read-only",
    approval: "never",
    allowedTools: [
      "read_file",
      "glob",
      "grep",
      "list_dir",
      "git_status",
      "git_diff",
    ],
    deniedTools: [
      "write_file",
      "edit_file",
      "shell",
      "git_commit",
      "spawn_subagent",
    ],
    systemAddendum: `You are in Plan mode. Produce structured plans with:
- Goal and constraints
- Step-by-step approach
- Files to modify (with rationale)
- Risks and open questions
Do NOT make changes. When the plan is ready, tell the user to switch to Agent mode to execute.`,
  },
  agent: {
    name: "agent",
    description: "Full coding agent with workspace write access",
    sandbox: "workspace-write",
    approval: "on-request",
    deniedTools: [],
    systemAddendum: `You are in Agent mode. You can read and modify files in the workspace, run shell commands, and spawn sub-agents when needed. Always explain what you're doing before making significant changes.`,
  },
  ask: {
    name: "ask",
    description: "Read-only Q&A about the codebase",
    sandbox: "read-only",
    approval: "never",
    allowedTools: ["read_file", "glob", "grep", "list_dir", "git_status", "git_diff"],
    deniedTools: [
      "write_file",
      "edit_file",
      "shell",
      "git_commit",
      "spawn_subagent",
    ],
    systemAddendum: `You are in Ask mode. Answer questions about the codebase using read-only tools. Do not suggest making changes unless asked.`,
  },
};

const WRITE_TOOLS = new Set(["write_file", "edit_file", "shell", "git_commit", "spawn_subagent"]);
const NETWORK_TOOLS = new Set(["shell"]);

export interface PolicyContext {
  cwd: string;
  targetPath?: string;
  shellCommand?: string;
}

export class PolicyEngine {
  private mode: ModeProfile;
  private rules: PolicyRule[] = [];
  private sessionApprovals = new Set<string>();
  private projectApprovals = new Set<string>();
  private sessionCategoryApprovals = new Set<ApprovalCategory>();
  private projectCategoryApprovals = new Set<ApprovalCategory>();
  private approvalPolicy: ApprovalPolicy;

  constructor(modeName = "agent", rules: PolicyRule[] = []) {
    this.mode = MODE_PROFILES[modeName] ?? MODE_PROFILES.agent;
    this.approvalPolicy = this.mode.approval;
    this.rules = rules;
  }

  setMode(modeName: string): void {
    this.mode = MODE_PROFILES[modeName] ?? MODE_PROFILES.agent;
    this.approvalPolicy = this.mode.approval;
  }

  getMode(): ModeProfile {
    return this.mode;
  }

  addRule(rule: PolicyRule): void {
    this.rules.push(rule);
  }

  approveSession(toolName: string): void {
    this.sessionApprovals.add(toolName);
  }

  approveProject(toolName: string): void {
    this.projectApprovals.add(toolName);
  }

  approveCategorySession(category: ApprovalCategory): void {
    this.sessionCategoryApprovals.add(category);
  }

  approveCategoryProject(category: ApprovalCategory): void {
    this.projectCategoryApprovals.add(category);
  }

  getAvailableScopes(_toolName: string): ApprovalScope[] {
    // All scopes are always available; category scope shown in UI
    return ["once", "session", "project"];
  }

  evaluate(toolCall: ToolCall, context: PolicyContext): PolicyDecision {
    const toolName = toolCall.function.name;
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(toolCall.function.arguments || "{}");
    } catch {
      // malformed args — still evaluate tool name
    }

    // Mode-level deny list
    if (this.mode.deniedTools?.includes(toolName)) {
      return { action: "deny", reason: `Tool '${toolName}' is not allowed in ${this.mode.name} mode` };
    }

    // Mode-level allow list (if specified, only listed tools pass)
    if (this.mode.allowedTools && !this.mode.allowedTools.includes(toolName)) {
      return { action: "deny", reason: `Tool '${toolName}' is not in the allowed list for ${this.mode.name} mode` };
    }

    // Project rules
    for (const rule of this.rules) {
      if (rule.tool && rule.tool !== toolName) continue;

      if (rule.action === "deny") {
        return { action: "deny", reason: `Denied by project rule for tool '${toolName}'` };
      }

      if (rule.action === "deny_write" && rule.path) {
        const targetPath = (args.path as string) ?? context.targetPath ?? "";
        if (matchesGlob(targetPath, rule.path)) {
          return { action: "deny", reason: `Write to '${targetPath}' is denied by project rule` };
        }
      }

      if (rule.action === "auto_approve" && rule.pattern) {
        const cmd = (args.command as string) ?? context.shellCommand ?? "";
        if (matchesPattern(cmd, rule.pattern)) {
          return { action: "allow" };
        }
      }
    }

    // Sandbox checks
    const sandboxDecision = this.checkSandbox(toolName, args, context);
    if (sandboxDecision) return sandboxDecision;

    // Category-level approvals (check before specific tool approvals — broader scope)
    const category = TOOL_CATEGORY[toolName];
    if (category && (this.sessionCategoryApprovals.has(category) || this.projectCategoryApprovals.has(category))) {
      return { action: "allow" };
    }

    // Session/project approvals (specific tool)
    if (this.sessionApprovals.has(toolName) || this.projectApprovals.has(toolName)) {
      return { action: "allow" };
    }

    // Approval policy
    if (this.approvalPolicy === "never") {
      return { action: "allow" };
    }

    if (this.approvalPolicy === "always") {
      return { action: "ask", scopes: ["once", "session", "project"] };
    }

    // on-request: ask for write/network tools
    if (WRITE_TOOLS.has(toolName) || this.needsNetworkApproval(toolName, args)) {
      return { action: "ask", scopes: ["once", "session", "project"] };
    }

    return { action: "allow" };
  }

  private checkSandbox(
    toolName: string,
    args: Record<string, unknown>,
    context: PolicyContext,
  ): PolicyDecision | null {
    const sandbox = this.mode.sandbox;

    if (sandbox === "full-access") return null;

    if (sandbox === "read-only") {
      if (WRITE_TOOLS.has(toolName)) {
        return { action: "deny", reason: `Write tool '${toolName}' blocked in read-only sandbox` };
      }
      if (toolName === "shell") {
        return { action: "deny", reason: "Shell commands blocked in read-only sandbox" };
      }
      return null;
    }

    // workspace-write
    if (toolName === "write_file" || toolName === "edit_file") {
      const targetPath = (args.path as string) ?? "";
      if (targetPath && !isWithinWorkspace(targetPath, context.cwd)) {
        return {
          action: "ask",
          scopes: ["once", "session"],
        };
      }
    }

    if (toolName === "shell") {
      const cmd = (args.command as string) ?? "";
      if (this.isNetworkCommand(cmd)) {
        return { action: "ask", scopes: ["once", "session"] };
      }
    }

    if (NETWORK_TOOLS.has(toolName)) {
      return { action: "ask", scopes: ["once", "session"] };
    }

    return null;
  }

  private needsNetworkApproval(toolName: string, args: Record<string, unknown>): boolean {
    if (toolName === "shell") {
      return this.isNetworkCommand((args.command as string) ?? "");
    }
    return false;
  }

  private isNetworkCommand(cmd: string): boolean {
    const networkPatterns = /\b(curl|wget|npm install|pnpm install|yarn add|pip install|git clone|git push|git pull|ssh|scp)\b/i;
    return networkPatterns.test(cmd);
  }
}

function isWithinWorkspace(targetPath: string, cwd: string): boolean {
  const normalized = targetPath.replace(/\\/g, "/");
  const normalizedCwd = cwd.replace(/\\/g, "/");
  if (normalized.startsWith(normalizedCwd)) return true;
  // relative paths are within workspace
  if (!normalized.startsWith("/") && !/^[A-Za-z]:/.test(normalized)) return true;
  return false;
}

function matchesGlob(path: string, pattern: string): boolean {
  const regex = new RegExp(
    "^" + pattern.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*").replace(/\./g, "\\.") + "$",
  );
  return regex.test(path.replace(/\\/g, "/"));
}

function matchesPattern(value: string, pattern: string): boolean {
  const regex = new RegExp("^" + pattern.replace(/\*/g, ".*").replace(/\./g, "\\.") + "$", "i");
  return regex.test(value);
}

export { MODE_PROFILES as modeProfiles };
