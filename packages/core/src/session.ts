import { randomUUID } from "node:crypto";
import type { OpenAICompatibleProvider } from "@nhicode/models";
import { PolicyEngine } from "@nhicode/policy";
import { ToolRegistry } from "@nhicode/tools";
import { ContextBuilder, AGENT_PROFILES } from "@nhicode/context";
import type {
  ApprovalResponse,
  ApprovalScope,
  Message,
  SessionConfig,
  SessionEvent,
  SessionStatus,
  SubAgentConfig,
  ToolCall,
  TurnResult,
  Unsubscribe,
} from "@nhicode/shared";
import { TOOL_CATEGORY } from "@nhicode/shared";

export interface AgentEngineOptions {
  maxTurns?: number;
  maxDepth?: number;
  onSpawnSubAgent?: (parentId: string, config: SubAgentConfig) => Promise<import("./session.js").Session>;
}

export class Session {
  readonly id: string;
  readonly cwd: string;
  readonly parentId?: string;

  private mode: string;
  private model: string;
  private status: SessionStatus = "idle";
  private history: Message[] = [];
  private listeners = new Set<(event: SessionEvent) => void>();
  private pendingApprovals = new Map<string, { call: ToolCall; resolve: (r: ApprovalResponse) => void }>();
  private abortController: AbortController | null = null;

  private provider: OpenAICompatibleProvider;
  private policy: PolicyEngine;
  private tools: ToolRegistry;
  private context: ContextBuilder;
  private options: AgentEngineOptions;
  private depth: number;
  private title: string;
  private agentProfile?: string;

  constructor(
    config: SessionConfig,
    provider: OpenAICompatibleProvider,
    policy: PolicyEngine,
    tools: ToolRegistry,
    context: ContextBuilder,
    options: AgentEngineOptions = {},
    depth = 0,
  ) {
    this.id = config.id ?? randomUUID();
    this.cwd = config.cwd;
    this.mode = config.mode;
    this.model = config.model;
    this.parentId = config.parentId;
    this.provider = provider;
    this.policy = policy;
    this.tools = tools;
    this.context = context;
    this.options = options;
    this.depth = depth;
    this.title = "New thread";
    this.agentProfile = config.agentProfile;
    this.policy.setMode(this.mode);
  }

  getStatus(): SessionStatus {
    return this.status;
  }

  getMode(): string {
    return this.mode;
  }

  getModel(): string {
    return this.model;
  }

  getTitle(): string {
    return this.title;
  }

  getHistory(): Message[] {
    return [...this.history];
  }

  restoreHistory(messages: Message[], title?: string): void {
    this.history = [...messages];
    if (title) this.title = title;
  }

  setMode(mode: string): void {
    this.mode = mode;
    this.policy.setMode(mode);
    this.context.reset();
    this.emit({ type: "mode_changed", mode });
  }

  on(listener: (event: SessionEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: SessionEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private setStatus(status: SessionStatus): void {
    this.status = status;
    this.emit({ type: "status_changed", status });
  }

  async send(message: string): Promise<TurnResult> {
    if (this.status === "running") {
      throw new Error("Session is already running");
    }

    this.abortController = new AbortController();
    this.setStatus("running");

    if (this.title === "New thread") {
      this.title = message.slice(0, 60) + (message.length > 60 ? "…" : "");
    }

    try {
      const result = await this.runLoop(message);
      if (result.status === "cancelled") {
        this.setStatus("cancelled");
      } else if (result.status === "error") {
        this.setStatus("error");
      } else {
        this.setStatus("completed");
      }
      this.emit({ type: "turn_complete", result });
      return result;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.setStatus("error");
      this.emit({ type: "error", error });
      return { text: "", toolCalls: [], status: "error", error };
    }
  }

  cancel(): void {
    this.abortController?.abort();
    for (const [requestId, pending] of this.pendingApprovals) {
      pending.resolve({ requestId, decision: "deny" });
    }
    this.pendingApprovals.clear();
    this.setStatus("cancelled");
  }

  respondToApproval(response: ApprovalResponse): void {
    const pending = this.pendingApprovals.get(response.requestId);
    if (pending) {
      pending.resolve(response);
      this.pendingApprovals.delete(response.requestId);
    }
  }

  private async runLoop(userMessage: string): Promise<TurnResult> {
    const modeProfile = this.policy.getMode();
    const profileDef = this.agentProfile ? AGENT_PROFILES[this.agentProfile] : undefined;
    const systemPrompt = await this.context.buildSystemPrompt({
      cwd: this.cwd,
      modeAddendum: modeProfile.systemAddendum,
      agentPrompt: profileDef?.systemPrompt,
    });

    let messages = this.context.buildMessages(systemPrompt, this.history, userMessage);
    this.history.push({ role: "user", content: userMessage });

    let fullText = "";
    let fullThinking = "";
    const allToolCalls: ToolCall[] = [];
    const maxTurns = this.options.maxTurns ?? 30;

    for (let turn = 0; turn < maxTurns; turn++) {
      if (this.abortController?.signal.aborted) {
        return { text: fullText, thinking: fullThinking, toolCalls: allToolCalls, status: "cancelled" };
      }

      let assistantMessage: Message | null = null;
      let turnText = "";
      let turnThinking = "";

      for await (const event of this.provider.chat({
        model: this.model,
        messages,
        tools: this.tools.getDefinitions(),
        stream: true,
        signal: this.abortController?.signal,
      })) {
        if (this.abortController?.signal.aborted) break;

        switch (event.type) {
          case "text_delta":
            turnText += event.content;
            fullText += event.content;
            this.emit({ type: "text_delta", content: event.content });
            break;
          case "thinking_delta":
            turnThinking += event.content;
            fullThinking += event.content;
            this.emit({ type: "thinking_delta", content: event.content });
            break;
          case "done":
            assistantMessage = event.message;
            if (turnText) assistantMessage.content = turnText;
            if (turnThinking && assistantMessage.tool_calls?.length) {
              assistantMessage.reasoning_content = turnThinking;
            }
            if (assistantMessage.tool_calls?.length && !assistantMessage.content) {
              assistantMessage.content = null;
            }
            break;
          case "error":
            throw new Error(event.error);
        }
      }

      if (this.abortController?.signal.aborted) {
        return { text: fullText, thinking: fullThinking, toolCalls: allToolCalls, status: "cancelled" };
      }

      if (!assistantMessage) {
        assistantMessage = {
          role: "assistant",
          content: turnText || null,
          reasoning_content: undefined,
        };
      }

      if (assistantMessage.tool_calls?.length) {
        for (const call of assistantMessage.tool_calls) {
          this.emit({ type: "tool_call", call });
          allToolCalls.push(call);
        }

        this.history.push(assistantMessage);
        messages.push(assistantMessage);

        for (const call of assistantMessage.tool_calls) {
          const result = await this.executeToolCall(call);
          this.emit({ type: "tool_result", result });
          const toolMessage: Message = {
            role: "tool",
            content: result.content,
            tool_call_id: call.id,
            name: call.function.name,
          };
          this.history.push(toolMessage);
          messages.push(toolMessage);
        }

        // Continue loop for next model turn
        continue;
      }

      // No tool calls — turn complete
      this.history.push(assistantMessage);
      return {
        text: fullText,
        thinking: fullThinking || undefined,
        toolCalls: allToolCalls,
        status: "completed",
      };
    }

    return {
      text: fullText,
      thinking: fullThinking || undefined,
      toolCalls: allToolCalls,
      status: "completed",
    };
  }

  private async executeToolCall(call: ToolCall) {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(call.function.arguments || "{}");
    } catch {
      // proceed with empty args
    }

    const decision = this.policy.evaluate(call, {
      cwd: this.cwd,
      targetPath: args.path as string | undefined,
      shellCommand: args.command as string | undefined,
    });

    if (decision.action === "deny") {
      return {
        toolCallId: call.id,
        name: call.function.name,
        content: `Denied: ${decision.reason}`,
        isError: true,
      };
    }

    if (decision.action === "ask") {
      const approved = await this.requestApproval(call, decision.scopes);
      if (!approved) {
        return {
          toolCallId: call.id,
          name: call.function.name,
          content: "User denied this action",
          isError: true,
        };
      }
    }

    const result = await this.tools.execute(call.function.name, args, {
      cwd: this.cwd,
      sessionId: this.id,
      toolCallId: call.id,
      spawnSubAgent: (profile, task, toolCallId) => this.spawnSubAgent(profile, task, toolCallId),
    });

    result.toolCallId = call.id;
    return result;
  }

  private async requestApproval(call: ToolCall, scopes: ApprovalScope[]): Promise<boolean> {
    const requestId = randomUUID();
    const category = TOOL_CATEGORY[call.function.name] ?? "file";
    this.setStatus("waiting_approval");

    const response = await new Promise<ApprovalResponse>((resolve) => {
      this.pendingApprovals.set(requestId, { call, resolve });
      this.emit({ type: "approval_required", call, scopes, requestId, category });
    });

    this.setStatus("running");

    switch (response.decision) {
      case "approve_once":
        return true;
      case "approve_session":
        this.policy.approveSession(call.function.name);
        return true;
      case "approve_project":
        this.policy.approveProject(call.function.name);
        return true;
      case "approve_category_session":
        this.policy.approveCategorySession(response.category ?? category);
        return true;
      case "approve_category_project":
        this.policy.approveCategoryProject(response.category ?? category);
        return true;
      case "deny":
        return false;
    }
  }

  async spawnSubAgent(profileName: string, task: string, toolCallId: string): Promise<string> {
    const maxDepth = this.options.maxDepth ?? 1;
    if (this.depth >= maxDepth) {
      return "Error: Maximum sub-agent depth reached";
    }

    if (!this.options.onSpawnSubAgent) {
      return "Error: Sub-agent spawning not configured";
    }

    const profile = AGENT_PROFILES[profileName];
    if (!profile) {
      return `Error: Unknown sub-agent profile '${profileName}'`;
    }

    const child = await this.options.onSpawnSubAgent(this.id, {
      profile: profileName,
      task,
      toolCallId,
      inheritPolicy: true,
      inheritCwd: true,
      inheritModel: true,
    });

    this.emit({
      type: "subagent_spawned",
      sessionId: child.id,
      profile: profileName,
      task,
      toolCallId,
    });

    const forward = child.on((event) => {
      this.emit({
        type: "subagent_event",
        childSessionId: child.id,
        profile: profileName,
        toolCallId,
        event,
      });
    });

    try {
      const result = await child.send(task);
      const summary = result.text || result.error || "(sub-agent completed with no output)";
      this.emit({
        type: "subagent_completed",
        sessionId: child.id,
        profile: profileName,
        toolCallId,
        result: summary,
      });
      return summary;
    } finally {
      forward();
    }
  }
}
