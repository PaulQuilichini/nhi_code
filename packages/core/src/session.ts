import { randomUUID } from "node:crypto";
import type { OpenAICompatibleProvider } from "@nhicode/models";
import { PolicyEngine } from "@nhicode/policy";
import { ToolRegistry } from "@nhicode/tools";
import { ContextBuilder, AGENT_PROFILES, buildThreadMemory, type ContextBudget } from "@nhicode/context";
import type {
  ApprovalRule,
  ApprovalResponse,
  ApprovalScope,
  ContextDiagnostics,
  Message,
  ModelInfo,
  ObservationRecord,
  SessionConfig,
  SessionEvent,
  SessionStatus,
  SubAgentConfig,
  TokenUsage,
  ToolCall,
  ToolResult,
  TurnStopReason,
  TurnResult,
  Unsubscribe,
} from "@nhicode/shared";
import { suggestShellPrefix, TOOL_CATEGORY } from "@nhicode/shared";
import {
  createObservationInput,
  expandedObservationContent,
  observationToolMessage,
} from "./observations.js";

export type PersistApprovalInput = Pick<ApprovalRule, "kind" | "toolName" | "category" | "prefix">;

export interface AgentEngineOptions {
  maxTurns?: number;
  maxDepth?: number;
  jobMaxRuntimeSeconds?: number;
  modelIdleTimeoutMs?: number;
  modelRequestTimeoutMs?: number;
  contextInputTokens?: number;
  contextOutputReserveTokens?: number;
  contextToolReserveTokens?: number;
  contextRecentTokens?: number;
  contextWorkingMemoryTokens?: number;
  contextObservationTokens?: number;
  contextDynamicTokens?: number;
  contextFileEvidenceTokens?: number;
  persistApproval?: (input: PersistApprovalInput) => ApprovalRule | undefined;
  recordObservation?: (input: Omit<ObservationRecord, "id" | "createdAt">) => ObservationRecord;
  listObservations?: (threadId: string, limit?: number) => ObservationRecord[];
  getObservation?: (threadId: string, id: string) => ObservationRecord | undefined;
  onSpawnSubAgent?: (parentId: string, config: SubAgentConfig) => Promise<import("./session.js").Session>;
}

export class Session {
  readonly id: string;
  readonly cwd: string;
  readonly parentId?: string;

  private mode: string;
  private model: string;
  private providerId: string;
  private modelMode?: string;
  private status: SessionStatus = "idle";
  private history: Message[] = [];
  private listeners = new Set<(event: SessionEvent) => void>();
  private pendingApprovals = new Map<string, { call: ToolCall; resolve: (r: ApprovalResponse) => void }>();
  private abortController: AbortController | null = null;
  private abortReason: TurnStopReason | null = null;
  private workingMemory: string | null = null;
  private lastContextDiagnostics?: ContextDiagnostics;

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
    this.providerId = config.providerId;
    this.modelMode = config.modelMode;
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

  getModelMode(): string | undefined {
    return this.modelMode;
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

  restoreMemory(memory?: string | null): void {
    this.workingMemory = memory?.trim() || null;
  }

  getWorkingMemory(): string | null {
    return this.workingMemory;
  }

  setMode(mode: string): void {
    this.mode = mode;
    this.policy.setMode(mode);
    this.context.reset();
    this.emit({ type: "mode_changed", mode });
  }

  setModelMode(modelMode?: string): void {
    this.modelMode = modelMode || undefined;
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
    if (this.status === "running" || this.status === "waiting_approval") {
      throw new Error("Session is already running");
    }

    this.abortController = new AbortController();
    this.abortReason = null;
    this.setStatus("running");

    if (this.title === "New thread") {
      this.title = message.slice(0, 60) + (message.length > 60 ? "…" : "");
    }

    const runtimeTimer = this.startRuntimeTimer();
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
      return {
        text: "",
        toolCalls: [],
        contextDiagnostics: this.lastContextDiagnostics,
        status: "error",
        error,
        reason: "session_error",
      };
    } finally {
      if (runtimeTimer) clearTimeout(runtimeTimer);
      this.abortReason = null;
    }
  }

  cancel(): void {
    this.abortReason = "cancelled";
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

    const modelInfo = this.provider.getModelInfo(this.model);
    const dynamicContext = await this.context.buildDynamicContext(this.cwd);
    const contextResult = this.context.buildContext(systemPrompt, this.history, userMessage, {
      workingMemory: this.workingMemory,
      dynamicContext,
      observations: this.options.listObservations?.(this.id, 80),
      threadId: this.id,
      model: this.model,
      providerId: this.providerId,
      budget: this.contextBudget(modelInfo),
    });
    let messages = contextResult.messages;
    this.lastContextDiagnostics = contextResult.diagnostics;
    this.emit({ type: "context_diagnostics", diagnostics: contextResult.diagnostics });
    this.history.push({ role: "user", content: userMessage });

    let fullText = "";
    let fullThinking = "";
    let lastUsage: TokenUsage | undefined;
    const allToolCalls: ToolCall[] = [];
    const maxTurns = this.options.maxTurns ?? 30;

    for (let turn = 0; turn < maxTurns; turn++) {
      if (this.abortController?.signal.aborted) {
        return this.abortedResult(fullText, fullThinking, allToolCalls);
      }

      let assistantMessage: Message | null = null;
      let turnText = "";
      let turnThinking = "";
      let providerError: { error: string; reason?: TurnStopReason } | null = null;
      let finishReason: string | undefined;

      for await (const event of this.provider.chat({
        model: this.model,
        messages,
        tools: this.tools.getDefinitions(),
        generationConfig: generationConfigForModelMode(this.modelMode),
        stream: true,
        idleTimeoutMs: this.options.modelIdleTimeoutMs,
        requestTimeoutMs: this.options.modelRequestTimeoutMs,
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
            if (event.usage) {
              lastUsage = event.usage;
              this.updateContextDiagnosticsWithUsage(event.usage);
            }
            assistantMessage = event.message;
            if (turnText) assistantMessage.content = turnText;
            if (turnThinking && assistantMessage.tool_calls?.length) {
              assistantMessage.reasoning_content = turnThinking;
            }
            if (assistantMessage.tool_calls?.length && !assistantMessage.content) {
              assistantMessage.content = null;
            }
            finishReason = event.finishReason;
            break;
          case "error":
            providerError = { error: event.error, reason: event.reason };
            break;
        }
        if (providerError) break;
      }

      if (this.abortController?.signal.aborted) {
        return this.abortedResult(fullText, fullThinking, allToolCalls);
      }

      if (providerError) {
        return {
          text: fullText,
          thinking: fullThinking || undefined,
          toolCalls: allToolCalls,
          usage: lastUsage,
          contextDiagnostics: this.lastContextDiagnostics,
          status: "error",
          error: providerError.error,
          reason: providerError.reason ?? "provider_error",
        };
      }

      if (!assistantMessage) {
        assistantMessage = {
          role: "assistant",
          content: turnText || null,
          reasoning_content: undefined,
        };
      }

      if (finishReason === "length") {
        return {
          text: fullText,
          thinking: fullThinking || undefined,
          toolCalls: allToolCalls,
          usage: lastUsage,
          contextDiagnostics: this.lastContextDiagnostics,
          status: "error",
          error: "Model stopped because it reached the output token limit before finishing.",
          reason: "model_output_limit",
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
          const args = parseToolCallArgs(call);
          const result = await this.executeToolCall(call, args);
          const observation = this.recordToolObservation(call, args, result);
          const eventResult: ToolResult = {
            ...result,
            observationId: observation?.id,
            rawContentLength: result.content.length,
            compacted: Boolean(observation),
          };
          this.emit({ type: "tool_result", result: eventResult });
          const toolMessage: Message = observation
            ? observationToolMessage(observation)
            : {
                role: "tool",
                content: result.content,
                tool_call_id: call.id,
                name: call.function.name,
              };
          this.history.push(toolMessage);
          messages.push(toolMessage);
        }

        this.refreshWorkingMemory();

        // Continue loop for next model turn
        continue;
      }

      // No tool calls — turn complete
      this.history.push(assistantMessage);
      return {
        text: fullText,
        thinking: fullThinking || undefined,
        toolCalls: allToolCalls,
        usage: lastUsage,
        contextDiagnostics: this.lastContextDiagnostics,
        status: "completed",
      };
    }

    return {
      text: fullText,
      thinking: fullThinking || undefined,
      toolCalls: allToolCalls,
      usage: lastUsage,
      contextDiagnostics: this.lastContextDiagnostics,
      status: "error",
      error: `Agent reached the maximum of ${maxTurns} model/tool turns before completing.`,
      reason: "max_turns_exceeded",
    };
  }

  private startRuntimeTimer(): ReturnType<typeof setTimeout> | undefined {
    const seconds = this.options.jobMaxRuntimeSeconds;
    if (!seconds || seconds <= 0) return undefined;
    return setTimeout(() => {
      this.abortReason = "job_timeout";
      this.abortController?.abort();
    }, seconds * 1000);
  }

  private contextBudget(modelInfo: ModelInfo): ContextBudget {
    return {
      maxContextTokens: modelInfo.maxContext,
      maxOutputTokens: modelInfo.maxOutput,
      inputTokens: this.options.contextInputTokens,
      outputReserveTokens: this.options.contextOutputReserveTokens,
      toolReserveTokens: this.options.contextToolReserveTokens,
      recentTokens: this.options.contextRecentTokens,
      workingMemoryTokens: this.options.contextWorkingMemoryTokens,
      observationTokens: this.options.contextObservationTokens,
      dynamicTokens: this.options.contextDynamicTokens,
      fileEvidenceTokens: this.options.contextFileEvidenceTokens,
    };
  }

  private updateContextDiagnosticsWithUsage(usage: TokenUsage): void {
    if (!this.lastContextDiagnostics) return;
    this.lastContextDiagnostics = {
      ...this.lastContextDiagnostics,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      cacheHitTokens: usage.promptCacheHitTokens ?? usage.cachedTokens,
      cacheMissTokens: usage.promptCacheMissTokens,
    };
    this.emit({ type: "context_diagnostics", diagnostics: this.lastContextDiagnostics });
  }

  private abortedResult(
    text: string,
    thinking: string,
    toolCalls: ToolCall[],
  ): TurnResult {
    if (this.abortReason === "job_timeout") {
      const seconds = this.options.jobMaxRuntimeSeconds ?? 0;
      return {
        text,
        thinking: thinking || undefined,
        toolCalls,
        contextDiagnostics: this.lastContextDiagnostics,
        status: "error",
        error: `Agent job exceeded the maximum runtime of ${seconds} seconds.`,
        reason: "job_timeout",
      };
    }
    return {
      text,
      thinking: thinking || undefined,
      toolCalls,
      contextDiagnostics: this.lastContextDiagnostics,
      status: "cancelled",
      reason: "cancelled",
    };
  }

  private async executeToolCall(
    call: ToolCall,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const contextToolResult = this.executeContextToolCall(call, args);
    if (contextToolResult) {
      return contextToolResult;
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

  private executeContextToolCall(
    call: ToolCall,
    args: Record<string, unknown>,
  ): ToolResult | null {
    switch (call.function.name) {
      case "expand_observation": {
        const id = typeof args.id === "string" ? args.id : "";
        const observation = id ? this.options.getObservation?.(this.id, id) : undefined;
        return {
          toolCallId: call.id,
          name: call.function.name,
          content: observation
            ? expandedObservationContent(observation, numberArg(args.maxChars) ?? undefined)
            : `Observation not found: ${id || "(missing id)"}`,
          isError: !observation,
        };
      }
      case "promote_context": {
        const note = typeof args.note === "string" ? args.note.trim() : "";
        if (!note) {
          return {
            toolCallId: call.id,
            name: call.function.name,
            content: "Error: note is required",
            isError: true,
          };
        }
        this.workingMemory = trimWorkingMemory(
          [this.workingMemory, `### Promoted Context\n${note}`].filter(Boolean).join("\n\n"),
        );
        return {
          toolCallId: call.id,
          name: call.function.name,
          content: "Promoted note to working memory.",
        };
      }
      case "drop_context": {
        const text = typeof args.text === "string" ? args.text.trim() : "";
        if (!text || !this.workingMemory) {
          return {
            toolCallId: call.id,
            name: call.function.name,
            content: "No matching working-memory text to drop.",
          };
        }
        const before = this.workingMemory;
        this.workingMemory = trimWorkingMemory(before.replace(text, "").trim());
        return {
          toolCallId: call.id,
          name: call.function.name,
          content:
            before === this.workingMemory
              ? "No exact working-memory match found."
              : "Dropped matching working-memory text.",
        };
      }
      case "summarize_phase": {
        const summary = typeof args.summary === "string" ? args.summary.trim() : "";
        if (!summary) {
          return {
            toolCallId: call.id,
            name: call.function.name,
            content: "Error: summary is required",
            isError: true,
          };
        }
        this.workingMemory = trimWorkingMemory(`### Phase Summary\n${summary}`);
        return {
          toolCallId: call.id,
          name: call.function.name,
          content: "Updated working memory with phase summary.",
        };
      }
      default:
        return null;
    }
  }

  private recordToolObservation(
    call: ToolCall,
    args: Record<string, unknown>,
    result: ToolResult,
  ): ObservationRecord | undefined {
    if (!this.options.recordObservation || isContextTool(call.function.name)) {
      return undefined;
    }
    return this.options.recordObservation(createObservationInput(this.id, call, args, result));
  }

  private refreshWorkingMemory(): void {
    const memory = buildThreadMemory(this.history, []);
    if (!memory.trim()) return;
    this.workingMemory = appendUniqueWorkingMemory(this.workingMemory, memory);
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
        if (call.function.name === "shell") {
          this.persistShellPrefixApproval(call, response.shellPrefix);
        } else if (!this.persistProjectApproval({ kind: "tool", toolName: call.function.name })) {
          this.policy.approveProject(call.function.name);
        }
        return true;
      case "approve_shell_prefix_project":
        this.persistShellPrefixApproval(call, response.shellPrefix);
        return true;
      case "approve_category_session":
        this.policy.approveCategorySession(response.category ?? category);
        return true;
      case "approve_category_project":
        if ((response.category ?? category) === "shell") {
          this.policy.approveCategorySession(response.category ?? category);
        } else if (!this.persistProjectApproval({ kind: "category", category: response.category ?? category })) {
          this.policy.approveCategoryProject(response.category ?? category);
        }
        return true;
      case "deny":
        return false;
    }
  }

  private persistShellPrefixApproval(call: ToolCall, prefix?: string): boolean {
    const command = shellCommandFromCall(call);
    const safePrefix = (prefix?.trim() || suggestShellPrefix(command)).trim();
    if (!safePrefix) return false;
    return this.persistProjectApproval({ kind: "shell_prefix", prefix: safePrefix });
  }

  private persistProjectApproval(input: PersistApprovalInput): boolean {
    const rule = this.options.persistApproval?.(input);
    if (!rule) return false;
    this.policy.addApprovalRule(rule);
    return true;
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

function shellCommandFromCall(call: ToolCall): string {
  try {
    const args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
    return typeof args.command === "string" ? args.command : "";
  } catch {
    return "";
  }
}

function parseToolCallArgs(call: ToolCall): Record<string, unknown> {
  try {
    const parsed = JSON.parse(call.function.arguments || "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function numberArg(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function isContextTool(name: string): boolean {
  return (
    name === "expand_observation" ||
    name === "promote_context" ||
    name === "drop_context" ||
    name === "summarize_phase"
  );
}

function trimWorkingMemory(value: string): string {
  const cleaned = value.trim();
  const maxChars = 16_000;
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(-maxChars).trimStart()}\n\n[Earlier working memory compacted.]`;
}

function appendUniqueWorkingMemory(existing: string | null, next: string): string {
  const sections = new Set(
    (existing ?? "")
      .split(/\n{2,}/)
      .map((section) => section.trim())
      .filter(Boolean),
  );
  for (const section of next.split(/\n{2,}/)) {
    const trimmed = section.trim();
    if (trimmed) sections.add(trimmed);
  }
  return trimWorkingMemory([...sections].join("\n\n"));
}

function generationConfigForModelMode(modelMode?: string): Record<string, unknown> | undefined {
  switch (modelMode) {
    case "deepseek-off":
      return { thinking: { type: "disabled" } };
    case "deepseek-max":
      return { thinking: { type: "enabled" }, reasoning_effort: "max" };
    case "deepseek-high":
      return { thinking: { type: "enabled" }, reasoning_effort: "high" };
    default:
      return undefined;
  }
}
