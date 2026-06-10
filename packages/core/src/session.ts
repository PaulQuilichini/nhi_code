import { randomUUID } from "node:crypto";
import { relative, resolve } from "node:path";
import type { OpenAICompatibleProvider } from "@nhicode/models";
import { PolicyEngine } from "@nhicode/policy";
import { ToolRegistry } from "@nhicode/tools";
import {
  ContextBuilder,
  AGENT_PROFILES,
  buildThreadMemory,
  type BuildBudgetedContextResult,
  type ContextBudget,
} from "@nhicode/context";
import type {
  AgentCarefulness,
  ApprovalRule,
  ApprovalResponse,
  ApprovalScope,
  ContextBudgetTier,
  ContextDiagnostics,
  Message,
  ModelInfo,
  ObservationRecord,
  SessionConfig,
  SessionEvent,
  SessionStatus,
  SubAgentConfig,
  TokenUsage,
  ToolDefinition,
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
  contextBudgetTier?: ContextBudgetTier;
  persistApproval?: (input: PersistApprovalInput) => ApprovalRule | undefined;
  recordObservation?: (input: Omit<ObservationRecord, "id" | "createdAt">) => ObservationRecord;
  listObservations?: (
    threadId: string,
    limit?: number,
    afterCreatedAt?: string,
  ) => ObservationRecord[];
  getObservation?: (threadId: string, id: string) => ObservationRecord | undefined;
  listRunEvents?: (
    threadId: string,
    limit?: number,
  ) => Array<{
    type: string;
    status?: string;
    message?: string;
    detail?: Record<string, unknown>;
  }>;
  onSpawnSubAgent?: (parentId: string, config: SubAgentConfig) => Promise<import("./session.js").Session>;
}

interface TurnReviewState {
  modified: boolean;
  modifiedPaths: Set<string>;
  reviewedPaths: Set<string>;
  reviewedAll: boolean;
  reviewedAfterModification: boolean;
  verificationRequested: boolean;
  verifiedAfterModification: boolean;
  reminderInjected: boolean;
  finalGateInjected: boolean;
  broadGateInjected: boolean;
  verifyGateInjected: boolean;
}

export class Session {
  readonly id: string;
  readonly cwd: string;
  readonly parentId?: string;

  private mode: string;
  private model: string;
  private providerId: string;
  private modelMode?: string;
  private contextBudgetTier: ContextBudgetTier;
  private agentCarefulness: AgentCarefulness;
  private status: SessionStatus = "idle";
  private history: Message[] = [];
  private listeners = new Set<(event: SessionEvent) => void>();
  private pendingApprovals = new Map<string, { call: ToolCall; resolve: (r: ApprovalResponse) => void }>();
  private abortController: AbortController | null = null;
  private abortReason: TurnStopReason | null = null;
  private workingMemory: string | null = null;
  private lastContextDiagnostics?: ContextDiagnostics;
  private steeringNotes: string[] = [];
  private observationFloorCreatedAt?: string;
  private promptInflationFactor = 1;
  private modelTurnsSinceCompaction = 0;
  private toolCallsSinceCompaction = 0;
  private compactionCount = 0;

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
    this.contextBudgetTier = config.contextBudgetTier ?? "compact";
    this.agentCarefulness = config.agentCarefulness ?? "standard";
    this.parentId = config.parentId;
    this.provider = provider;
    this.policy = policy;
    this.tools = tools;
    this.context = context;
    this.options = options;
    this.depth = depth;
    this.title = "New thread";
    this.agentProfile = config.agentProfile;
    this.promptInflationFactor = defaultPromptInflationFactor(this.providerId, this.model);
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

  getContextBudgetTier(): ContextBudgetTier {
    return this.contextBudgetTier;
  }

  getAgentCarefulness(): AgentCarefulness {
    return this.agentCarefulness;
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

  setContextBudgetTier(contextBudgetTier: ContextBudgetTier): void {
    this.contextBudgetTier = contextBudgetTier;
  }

  setMaxTurns(maxTurns: number): void {
    this.options.maxTurns = Math.max(0, Math.floor(maxTurns));
  }

  addSteering(note: string): void {
    const trimmed = note.trim();
    if (!trimmed) {
      throw new Error("Steering text is required");
    }
    if (this.status !== "running" && this.status !== "waiting_approval") {
      throw new Error("Steering is only available while the agent is running");
    }
    this.steeringNotes.push(trimmed.slice(0, 2_000));
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
      this.steeringNotes = [];
    }
  }

  async sendQueuedPrompt(promptId: string, message: string): Promise<TurnResult> {
    this.emit({ type: "queued_prompt_started", promptId, text: message });
    return this.send(message);
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
    const agentPrompt = [
      this.agentCarefulness === "codex" ? CODEX_CAREFULNESS_PROMPT : undefined,
      profileDef?.systemPrompt,
    ]
      .filter(Boolean)
      .join("\n\n");
    const systemPrompt = await this.context.buildSystemPrompt({
      cwd: this.cwd,
      modeAddendum: modeProfile.systemAddendum,
      agentPrompt: agentPrompt || undefined,
    });

    const modelInfo = this.provider.getModelInfo(this.model);
    this.history.push({ role: "user", content: userMessage });

    let fullText = "";
    let fullThinking = "";
    let lastUsage: TokenUsage | undefined;
    const allToolCalls: ToolCall[] = [];
    const maxTurns = Math.max(0, this.options.maxTurns ?? 0);
    const reviewState: TurnReviewState = {
      modified: false,
      modifiedPaths: new Set(),
      reviewedPaths: new Set(),
      reviewedAll: false,
      reviewedAfterModification: false,
      verificationRequested: detectVerificationRequest(userMessage),
      verifiedAfterModification: false,
      reminderInjected: false,
      finalGateInjected: false,
      broadGateInjected: false,
      verifyGateInjected: false,
    };
    let forceMaxReasoningTurn = false;
    let pendingGuidance: Message | null = null;

    for (let turn = 0; maxTurns === 0 || turn < maxTurns; turn++) {
      if (this.abortController?.signal.aborted) {
        return this.abortedResult(fullText, fullThinking, allToolCalls);
      }

      const messages = await this.buildTurnMessages(systemPrompt, modelInfo, pendingGuidance);
      pendingGuidance = null;

      let assistantMessage: Message | null = null;
      let turnText = "";
      let turnThinking = "";
      let providerError: { error: string; reason?: TurnStopReason } | null = null;
      let finishReason: string | undefined;
      const generationConfig = this.generationConfigForTurn(forceMaxReasoningTurn);
      forceMaxReasoningTurn = false;

      for await (const event of this.provider.chat({
        model: this.model,
        messages,
        tools: this.activeToolDefinitions(),
        generationConfig,
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

      this.modelTurnsSinceCompaction += 1;

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
          this.toolCallsSinceCompaction += 1;
          await this.appendDependentsNote(call.function.name, args, result);
          this.updateReviewStateAfterTool(call.function.name, args, result, reviewState);
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

        if (this.shouldRemindForReview(reviewState)) {
          pendingGuidance = reviewRequiredMessage("review_reminder");
          reviewState.reminderInjected = true;
          forceMaxReasoningTurn = true;
        }

        // Continue loop for next model turn
        continue;
      }

      // No tool calls — turn complete
      const gateMessage = this.finalAnswerGate(reviewState);
      if (gateMessage) {
        // Keep the draft in history so the next turn builds on it instead of
        // re-deriving, but exclude it from the user-visible result.
        this.history.push(assistantMessage);
        fullText = removeTrailingTurnText(fullText, turnText);
        pendingGuidance = gateMessage;
        forceMaxReasoningTurn = true;
        continue;
      }

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
      tier: this.contextBudgetTier,
      providerId: this.providerId,
      model: this.model,
      inputTokens: this.options.contextInputTokens,
      outputReserveTokens: this.options.contextOutputReserveTokens,
      toolReserveTokens: this.options.contextToolReserveTokens,
      recentTokens: this.options.contextRecentTokens,
      workingMemoryTokens: this.options.contextWorkingMemoryTokens,
      observationTokens: this.options.contextObservationTokens,
      dynamicTokens: this.options.contextDynamicTokens,
    };
  }

  private activeToolDefinitions(): ToolDefinition[] {
    const profile = this.policy.getMode();
    return this.tools.getDefinitions({
      allowedTools: profile.allowedTools,
      deniedTools: profile.deniedTools,
    });
  }

  private async buildTurnMessages(
    systemPrompt: string,
    modelInfo: ModelInfo,
    pendingGuidance: Message | null,
  ): Promise<Message[]> {
    const guidanceText = pendingGuidance?.content?.trim() || "";
    const steeringText = this.steeringNotes
      .map((note) => note.trim())
      .filter(Boolean)
      .join("\n- ");
    let compactedForThisTurn = false;

    while (true) {
      if (!compactedForThisTurn && this.shouldCompactBeforeBuild()) {
        this.compactThreadState();
        compactedForThisTurn = true;
      }

      const dynamicContext = await this.buildTurnDynamicContext(guidanceText, steeringText);
      const contextBuildOptions = {
        workingMemory: this.workingMemory,
        dynamicContext,
        observations: this.options.listObservations?.(
          this.id,
          80,
          this.observationFloorCreatedAt,
        ),
        threadId: this.id,
        model: this.model,
        providerId: this.providerId,
        budget: this.contextBudget(modelInfo),
      };
      const contextResult = this.annotateContextDiagnostics(
        await this.refineContextWithProviderEstimate(
          this.context.buildContext(systemPrompt, this.history, null, contextBuildOptions),
          systemPrompt,
          null,
          contextBuildOptions,
          modelInfo,
        ),
      );
      const promptEstimate =
        contextResult.diagnostics.adjustedInputTokens ??
        contextResult.diagnostics.estimatedInputTokens;
      if (
        !compactedForThisTurn &&
        promptEstimate >= (contextResult.diagnostics.promptCeilingTokens ?? Number.POSITIVE_INFINITY)
      ) {
        this.compactThreadState();
        compactedForThisTurn = true;
        continue;
      }

      this.lastContextDiagnostics = contextResult.diagnostics;
      this.emit({ type: "context_diagnostics", diagnostics: contextResult.diagnostics });
      if (steeringText) {
        this.steeringNotes = [];
      }
      return contextResult.messages;
    }
  }

  private async buildTurnDynamicContext(
    guidanceText: string,
    steeringText: string,
  ): Promise<string | null> {
    const parts: string[] = [];
    if (guidanceText) {
      parts.push(guidanceText);
    }
    if (steeringText) {
      parts.push(`## Live User Steering\n- ${steeringText}`);
    }
    const workspaceState = await this.context.buildDynamicContext(this.cwd);
    if (workspaceState) {
      parts.push(workspaceState);
    }
    return parts.join("\n\n").trim() || null;
  }

  private annotateContextDiagnostics(
    result: BuildBudgetedContextResult,
  ): BuildBudgetedContextResult {
    const profile = contextCompactionProfile(this.contextBudgetTier);
    const estimatedToolTokens = estimateToolDefinitionTokens(this.activeToolDefinitions());
    const estimatedInputTokens = result.diagnostics.estimatedInputTokens + estimatedToolTokens;
    const adjustedInputTokens = Math.ceil(estimatedInputTokens * this.promptInflationFactor);
    return {
      ...result,
      diagnostics: {
        ...result.diagnostics,
        estimatedInputTokens,
        adjustedInputTokens,
        estimatedToolTokens,
        promptInflationFactor: this.promptInflationFactor,
        promptCeilingTokens: profile.promptCeilingTokens,
        hardPromptCeilingTokens: profile.hardPromptTokens,
        compactionCount: this.compactionCount,
        modelTurnsSinceCompaction: this.modelTurnsSinceCompaction,
        toolCallsSinceCompaction: this.toolCallsSinceCompaction,
      },
    };
  }

  private shouldCompactBeforeBuild(): boolean {
    const profile = contextCompactionProfile(this.contextBudgetTier);
    const lastPrompt =
      this.lastContextDiagnostics?.promptTokens ??
      this.lastContextDiagnostics?.adjustedInputTokens ??
      this.lastContextDiagnostics?.estimatedInputTokens ??
      0;
    return (
      this.modelTurnsSinceCompaction >= profile.modelTurns ||
      this.toolCallsSinceCompaction >= profile.toolCalls ||
      lastPrompt >= profile.promptCeilingTokens
    );
  }

  private compactThreadState(): void {
    const recentEvents = this.options.listRunEvents?.(this.id, 80) ?? [];
    const rebuiltMemory = buildThreadMemory(this.history, recentEvents);
    this.workingMemory = mergeCompactedWorkingMemory(this.workingMemory, rebuiltMemory);
    this.history = this.context.compactHistory(
      this.history,
      contextCompactionProfile(this.contextBudgetTier).historyMessages,
    );
    const latestObservation = this.options.listObservations?.(this.id, 1)?.at(-1);
    this.observationFloorCreatedAt = laterIsoTimestamp(
      this.observationFloorCreatedAt,
      latestObservation?.createdAt ?? new Date().toISOString(),
    );
    this.modelTurnsSinceCompaction = 0;
    this.toolCallsSinceCompaction = 0;
    this.compactionCount += 1;
  }

  private async refineContextWithProviderEstimate(
    result: BuildBudgetedContextResult,
    systemPrompt: string,
    userMessage: string | null,
    options: Parameters<ContextBuilder["buildContext"]>[3],
    modelInfo: ModelInfo,
  ): Promise<BuildBudgetedContextResult> {
    const estimated = await this.provider.estimateTokens(result.messages, this.model).catch(() => undefined);
    if (!estimated) return result;
    if (estimated <= result.diagnostics.inputBudgetTokens) {
      return {
        ...result,
        diagnostics: { ...result.diagnostics, estimatedInputTokens: estimated },
      };
    }

    const scale = Math.max(
      0.25,
      (result.diagnostics.inputBudgetTokens / estimated) * 0.9,
    );
    const adjustedBudget: ContextBudget = {
      ...this.contextBudget(modelInfo),
      inputTokens: Math.max(8_000, Math.floor(result.diagnostics.inputBudgetTokens * scale)),
    };
    const rebuilt = this.context.buildContext(systemPrompt, this.history, userMessage, {
      ...options,
      budget: adjustedBudget,
    });
    const rebuiltEstimate = await this.provider
      .estimateTokens(rebuilt.messages, this.model)
      .catch(() => undefined);
    return rebuiltEstimate
      ? {
          ...rebuilt,
          diagnostics: { ...rebuilt.diagnostics, estimatedInputTokens: rebuiltEstimate },
        }
      : rebuilt;
  }

  private updateContextDiagnosticsWithUsage(usage: TokenUsage): void {
    if (!this.lastContextDiagnostics) return;
    const estimated = this.lastContextDiagnostics.estimatedInputTokens;
    if (estimated > 0) {
      this.promptInflationFactor = Math.min(
        4,
        Math.max(this.promptInflationFactor, usage.promptTokens / estimated),
      );
    }
    this.lastContextDiagnostics = {
      ...this.lastContextDiagnostics,
      promptInflationFactor: this.promptInflationFactor,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      cacheHitTokens: usage.promptCacheHitTokens ?? usage.cachedTokens,
      cacheMissTokens: usage.promptCacheMissTokens,
    };
    this.emit({ type: "context_diagnostics", diagnostics: this.lastContextDiagnostics });
  }

  private generationConfigForTurn(forceMaxReasoning: boolean): Record<string, unknown> | undefined {
    const modelMode =
      isDeepSeekSelection(this.providerId, this.model) &&
      (forceMaxReasoning || this.mode === "plan" || this.agentProfile === "reviewer")
        ? "deepseek-max"
        : this.modelMode;
    return generationConfigForModelMode(modelMode);
  }

  private updateReviewStateAfterTool(
    toolName: string,
    args: Record<string, unknown>,
    result: ToolResult,
    state: TurnReviewState,
  ): void {
    if (this.mode !== "agent") return;

    if (isReviewToolCall(toolName, args)) {
      if (result.isError) return;
      if (state.modified) state.reviewedAfterModification = true;
      if (toolName === "read_file") {
        const path = this.normalizeTrackedPath(args.path);
        if (path) state.reviewedPaths.add(path);
      } else if (toolName === "git_diff") {
        const path = this.normalizeTrackedPath(args.path);
        if (path) state.reviewedPaths.add(path);
        else state.reviewedAll = true;
      } else if (toolName === "spawn_subagent") {
        state.reviewedAll = true;
      } else if (toolName === "shell" && state.modified) {
        state.verifiedAfterModification = true;
      }
      return;
    }

    if (isModifyingToolCall(toolName, args)) {
      if (result.isError) return;
      state.modified = true;
      state.reviewedAfterModification = false;
      state.verifiedAfterModification = false;
      state.reviewedAll = false;
      state.reminderInjected = false;
      state.finalGateInjected = false;
      state.broadGateInjected = false;
      state.verifyGateInjected = false;
      if (toolName === "write_file" || toolName === "edit_file") {
        const path = this.normalizeTrackedPath(args.path);
        if (path) {
          state.modifiedPaths.add(path);
          state.reviewedPaths.delete(path);
        }
      }
    }
  }

  private shouldRemindForReview(state: TurnReviewState): boolean {
    return (
      this.agentCarefulness === "codex" &&
      this.mode === "agent" &&
      state.modified &&
      !state.reviewedAfterModification &&
      !state.reminderInjected
    );
  }

  /** Decide whether the final answer should be held back for one more review/verify turn. */
  private finalAnswerGate(state: TurnReviewState): Message | null {
    if (this.mode !== "agent" || !state.modified) return null;

    if (
      this.agentCarefulness === "codex" &&
      !state.reviewedAfterModification &&
      !state.finalGateInjected
    ) {
      state.finalGateInjected = true;
      return reviewRequiredMessage("final_gate");
    }

    if (this.agentCarefulness === "codex" && !state.broadGateInjected) {
      const unreviewed = [...state.modifiedPaths].filter((p) => !state.reviewedPaths.has(p));
      if (
        state.modifiedPaths.size >= 2 &&
        unreviewed.length > 0 &&
        !state.reviewedAll &&
        !state.verifiedAfterModification
      ) {
        state.broadGateInjected = true;
        return broadReviewMessage(unreviewed, this.cwd);
      }
    }

    if (
      state.verificationRequested &&
      !state.verifiedAfterModification &&
      !state.verifyGateInjected
    ) {
      state.verifyGateInjected = true;
      return reviewRequiredMessage("verification");
    }

    return null;
  }

  private normalizeTrackedPath(value: unknown): string | null {
    if (typeof value !== "string" || !value.trim()) return null;
    const resolved = resolve(this.cwd, value.trim());
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
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

  /**
   * After a successful write/edit, surface files that import the changed module
   * so the model sees potential knock-on effects in the observation.
   */
  private async appendDependentsNote(
    toolName: string,
    args: Record<string, unknown>,
    result: ToolResult,
  ): Promise<void> {
    if (result.isError || (toolName !== "write_file" && toolName !== "edit_file")) return;
    const path = typeof args.path === "string" ? args.path.trim() : "";
    if (!path) return;

    const base = path.replace(/\\/g, "/").split("/").pop() ?? "";
    const match = /^(.+)\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|py)$/i.exec(base);
    if (!match) return;
    const stem = match[1];
    if (!stem || GENERIC_MODULE_STEMS.has(stem.toLowerCase())) return;

    const escaped = escapeRegExp(stem);
    const isPython = match[2].toLowerCase() === "py";
    const pattern = isPython
      ? `(from\\s+\\S*\\b${escaped}\\s+import|import\\s+\\S*\\b${escaped}\\b)`
      : `(from\\s+['"][^'"]*${escaped}(\\.js)?['"]|require\\(['"][^'"]*${escaped}|import\\s+['"][^'"]*${escaped})`;
    const glob = isPython ? "**/*.py" : "**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts}";

    try {
      const grep = await this.tools.execute(
        "grep",
        { pattern, glob },
        { cwd: this.cwd, sessionId: this.id },
      );
      if (grep.isError || !grep.content || grep.content === "(no matches)") return;

      const editedPath = this.normalizeTrackedPath(path);
      const dependents = grep.content.split("\n").filter((line) => {
        const file = line.split(":", 1)[0];
        return file && this.normalizeTrackedPath(file) !== editedPath;
      });
      if (dependents.length === 0) return;

      const shown = dependents.slice(0, 8);
      const more = dependents.length > shown.length ? `\n[... ${dependents.length - shown.length} more]` : "";
      result.content =
        `${result.content}\n\n` +
        `Note: ${dependents.length} other location(s) reference '${base}' — check for knock-on effects:\n` +
        shown.join("\n") +
        more;
    } catch {
      // best-effort hint — never fail the tool call over it
    }
  }

  private refreshWorkingMemory(): void {
    const memory = buildThreadMemory(this.history, this.options.listRunEvents?.(this.id, 40) ?? []);
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

function reviewRequiredMessage(kind: "review_reminder" | "final_gate" | "verification"): Message {
  if (kind === "verification") {
    return {
      role: "system",
      content:
        "Do not finalize yet. The user explicitly asked for tests or checks to be run. Run the requested verification now, report the results, then provide your complete final answer.",
    };
  }
  const prefix =
    kind === "final_gate"
      ? "Do not finalize yet."
      : "Before finalizing this coding task,";
  const suffix =
    kind === "final_gate"
      ? " Afterwards, provide your complete final answer."
      : "";
  return {
    role: "system",
    content:
      `${prefix} review the changes made after the last write. Use tools now: inspect the changed files or diff, run a relevant check when one is available, then either fix issues or explicitly state why a check could not be run.${suffix}`,
  };
}

function broadReviewMessage(unreviewedPaths: string[], cwd: string): Message {
  const listed = unreviewedPaths
    .slice(0, 10)
    .map((p) => `- ${relative(cwd, p) || p}`)
    .join("\n");
  return {
    role: "system",
    content:
      `Do not finalize yet. You modified multiple files, but some were not reviewed after the changes:\n${listed}\nRun git_diff over the full workspace or read each modified file, fix any issues, then provide your complete final answer.`,
  };
}

function detectVerificationRequest(message: string): boolean {
  return (
    /\b(?:run|execute|rerun|re-run)\b[^.!?\n]{0,60}\b(?:tests?|test\s+suite|checks?|lint(?:er)?|typecheck(?:ing)?|build)\b/i.test(message) ||
    /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|lint|typecheck|check|build)\b/i.test(message) ||
    /\b(?:pytest|vitest|jest|tsc|cargo\s+(?:test|check)|dotnet\s+test|go\s+test)\b/i.test(message)
  );
}

function removeTrailingTurnText(fullText: string, turnText: string): string {
  return turnText && fullText.endsWith(turnText)
    ? fullText.slice(0, fullText.length - turnText.length)
    : fullText;
}

function isModifyingToolCall(toolName: string, args: Record<string, unknown>): boolean {
  if (toolName === "write_file" || toolName === "edit_file" || toolName === "git_commit") {
    return true;
  }
  if (toolName === "spawn_subagent") {
    return args.profile === "implementer";
  }
  if (toolName === "shell") {
    const command = shellText(args);
    return Boolean(command) && !isReadonlyShellCommand(command) && !isVerificationShellCommand(command);
  }
  return false;
}

function isReviewToolCall(toolName: string, args: Record<string, unknown>): boolean {
  if (toolName === "git_diff" || toolName === "git_status" || toolName === "read_file") return true;
  if (toolName === "spawn_subagent") return args.profile === "reviewer";
  if (toolName === "shell") return isVerificationShellCommand(shellText(args));
  return false;
}

function shellText(args: Record<string, unknown>): string {
  const command = typeof args.command === "string" ? args.command : "";
  const script = typeof args.script === "string" ? args.script : "";
  return command || script;
}

function isReadonlyShellCommand(command: string): boolean {
  const normalized = command.trim();
  return /^(git\s+(status|diff|show|log)\b|rg\b|grep\b|ls\b|dir\b|pwd\b|cat\b|type\b|Get-Content\b|Get-ChildItem\b|Select-String\b)/i.test(
    normalized,
  );
}

function isVerificationShellCommand(command: string): boolean {
  const normalized = command.trim();
  return /\b(test|typecheck|check|lint|build|tsc|vitest|jest|pytest|cargo\s+test|cargo\s+check|dotnet\s+test)\b/i.test(
    normalized,
  );
}

function isDeepSeekSelection(providerId: string, model: string): boolean {
  return `${providerId} ${model}`.toLocaleLowerCase().includes("deepseek");
}

function trimWorkingMemory(value: string): string {
  const cleaned = value.trim();
  if (cleaned.length <= MAX_WORKING_MEMORY_CHARS) return cleaned;
  const sections = splitMemorySections(cleaned);
  const selected: string[] = [];
  let used = 0;
  for (let i = sections.length - 1; i >= 0; i--) {
    const section = sections[i];
    if (used + section.length > MAX_WORKING_MEMORY_CHARS) continue;
    selected.unshift(section);
    used += section.length;
  }
  return `${selected.join("\n\n").trim()}\n\n[Earlier working memory compacted.]`;
}

function appendUniqueWorkingMemory(existing: string | null, next: string): string {
  const sections = new Map<string, string>();
  for (const section of splitMemorySections(existing ?? "")) {
    sections.set(memorySectionKey(section), section);
  }
  for (const section of splitMemorySections(next)) {
    const trimmed = section.trim();
    if (!trimmed) continue;
    const key = memorySectionKey(trimmed);
    sections.delete(key);
    sections.set(key, trimmed);
  }
  const pinned: string[] = [];
  const rest: string[] = [];
  for (const section of sections.values()) {
    if (isPinnedMemorySection(section)) pinned.push(section);
    else rest.push(section);
  }
  const maxRestSections = Math.max(0, MAX_WORKING_MEMORY_SECTIONS - pinned.length);
  return trimWorkingMemory([...pinned, ...rest.slice(-maxRestSections)].join("\n\n"));
}

function generationConfigForModelMode(modelMode?: string): Record<string, unknown> | undefined {
  switch (modelMode) {
    case "deepseek-off":
      return { thinking: { type: "disabled" } };
    case "deepseek-low":
      return { thinking: { type: "enabled" }, reasoning_effort: "low" };
    case "deepseek-medium":
      return { thinking: { type: "enabled" }, reasoning_effort: "medium" };
    case "deepseek-max":
      return { thinking: { type: "enabled" }, reasoning_effort: "max" };
    case "deepseek-high":
      return { thinking: { type: "enabled" }, reasoning_effort: "high" };
    case "kimi-off":
      return { thinking: { type: "disabled" } };
    case "kimi-on":
      return { thinking: { type: "enabled" } };
    case "kimi-preserve":
      return { thinking: { type: "enabled", keep: "all" } };
    default:
      return undefined;
  }
}

const MAX_WORKING_MEMORY_CHARS = 16_000;
const MAX_WORKING_MEMORY_SECTIONS = 24;
const GENERIC_MODULE_STEMS = new Set(["index", "main", "mod", "__init__"]);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
const REPLACEABLE_MEMORY_TITLES = new Set([
  "### Latest User Request",
  "### Recent Agent Notes",
  "### Relevant Files",
  "### Recent Commands",
  "### Recent Failures",
]);

function splitMemorySections(value: string): string[] {
  return value
    .split(/\n{2,}/)
    .map((section) => section.trim())
    .filter(Boolean);
}

function memorySectionKey(section: string): string {
  const firstLine = section.split("\n", 1)[0]?.trim() ?? section;
  if (firstLine === "### Original Goal" || firstLine === "### Phase Summary") return firstLine;
  if (REPLACEABLE_MEMORY_TITLES.has(firstLine)) return firstLine;
  return section;
}

function isPinnedMemorySection(section: string): boolean {
  const firstLine = section.split("\n", 1)[0]?.trim() ?? "";
  return (
    firstLine === "### Original Goal" ||
    firstLine === "### Phase Summary" ||
    firstLine === "### Promoted Context"
  );
}

function mergeCompactedWorkingMemory(existing: string | null, rebuilt: string): string {
  const preserved = splitMemorySections(existing ?? "").filter(isPinnedMemorySection);
  return trimWorkingMemory([...preserved, ...splitMemorySections(rebuilt)].join("\n\n"));
}

function laterIsoTimestamp(a?: string, b?: string): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}

function defaultPromptInflationFactor(providerId: string, model: string): number {
  const selection = `${providerId} ${model}`.toLocaleLowerCase();
  if (selection.includes("deepseek")) return 1.6;
  if (selection.includes("kimi")) return 1.35;
  return 1.25;
}

function estimateToolDefinitionTokens(tools: ToolDefinition[]): number {
  if (tools.length === 0) return 0;
  return Math.ceil(JSON.stringify(tools).length / 4) + tools.length * 16;
}

function contextCompactionProfile(contextBudgetTier: ContextBudgetTier): {
  promptCeilingTokens: number;
  hardPromptTokens: number;
  modelTurns: number;
  toolCalls: number;
  historyMessages: number;
} {
  switch (contextBudgetTier) {
    case "full":
      return {
        promptCeilingTokens: 140_000,
        hardPromptTokens: 220_000,
        modelTurns: 12,
        toolCalls: 24,
        historyMessages: 42,
      };
    case "long":
      return {
        promptCeilingTokens: 90_000,
        hardPromptTokens: 140_000,
        modelTurns: 10,
        toolCalls: 18,
        historyMessages: 30,
      };
    default:
      return {
        promptCeilingTokens: 60_000,
        hardPromptTokens: 90_000,
        modelTurns: 8,
        toolCalls: 14,
        historyMessages: 18,
      };
  }
}

const CODEX_CAREFULNESS_PROMPT = `## Codex-Like Carefulness
For coding tasks, optimize for correctness over speed.
- Orient before editing: inspect relevant files, project state, and existing patterns before changing code.
- For nontrivial changes, form a brief plan before edits and keep changes scoped to the user's request.
- Before each write, verify the target path, the local pattern, and the expected diff.
- Use grep/glob/read_file before guessing where code lives.
- After major phases, use summarize_phase with the current state and next action.
- After any write or implementation shell command, review the changed file or git diff and run a relevant check when one is available before finalizing.
- If a check cannot be run, say why in the final response.`;
