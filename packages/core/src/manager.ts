import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { OpenAICompatibleProvider } from "@nhicode/models";
import { createProvidersFromConfig } from "@nhicode/models";
import { PolicyEngine } from "@nhicode/policy";
import { ToolRegistry } from "@nhicode/tools";
import {
  ContextBuilder,
  AGENT_PROFILES,
  buildThreadMemory,
  sanitizeMessageHistory,
} from "@nhicode/context";
import { loadConfig, resolveApiKey } from "@nhicode/shared";
import type {
  ApprovalRule,
  ApprovalResponse,
  ObservationRecord,
  Message,
  Project,
  SessionConfig,
  SessionEvent,
  SubAgentConfig,
  NhiCodeConfig,
  ThreadSummary,
  Unsubscribe,
} from "@nhicode/shared";
import { Session } from "./session.js";
import type { AgentEngineOptions, PersistApprovalInput } from "./session.js";
import { JsonStore } from "./store.js";
import { ApiKeyStore } from "./keys.js";
import type { StoredMessage, StoredRunEvent } from "./store.js";

export interface SessionManagerOptions {
  dataDir?: string;
  apiKeys?: Record<string, string>;
  defaultProjectPath?: string;
}

export class SessionManager {
  private store: JsonStore;
  private keyStore: ApiKeyStore;
  private sessions = new Map<string, Session>();
  private providers = new Map<string, OpenAICompatibleProvider>();
  private config: NhiCodeConfig;
  private tools = new ToolRegistry();
  private apiKeys: Record<string, string>;

  constructor(options: SessionManagerOptions = {}) {
    const dataDir = options.dataDir ?? resolveDataDir();
    mkdirSync(dataDir, { recursive: true });
    this.store = new JsonStore(dataDir, options.defaultProjectPath);
    this.keyStore = new ApiKeyStore(dataDir);
    this.apiKeys = { ...this.keyStore.getAll(), ...options.apiKeys };
    this.config = { default: {}, providers: [] };
  }

  async initialize(cwd?: string): Promise<void> {
    this.config = await loadConfig(cwd);
    this.tools.setShellTimeoutMs(
      secondsToMs(this.config.agents?.shell_timeout_seconds ?? 1800),
    );
    this.rebuildProviders();
  }

  private rebuildProviders(): void {
    this.providers = createProvidersFromConfig(
      this.config.providers
        .map((p) => {
          const apiKey =
            this.apiKeys[p.id] ??
            resolveApiKey(p) ??
            (p.api_key_env ? process.env[p.api_key_env] : undefined);
          if (!apiKey) return null;
          return {
            id: p.id,
            base_url: p.base_url,
            api_key: apiKey,
            default_model: p.default_model,
            generation_config: p.generation_config,
          };
        })
        .filter(Boolean) as Array<{
        id: string;
        base_url: string;
        api_key: string;
        default_model: string;
        generation_config?: Record<string, unknown>;
      }>,
    );
  }

  setApiKey(providerId: string, key: string): void {
    this.apiKeys[providerId] = key;
    this.keyStore.set(providerId, key);
    this.rebuildProviders();
  }

  getConfig(): NhiCodeConfig {
    return this.config;
  }

  getProviders(): string[] {
    return Array.from(this.providers.keys());
  }

  listProjects(): Project[] {
    return this.store.listProjects();
  }

  createProject(input: { name?: string; path: string }): Project {
    return this.store.createProject(input);
  }

  updateProject(id: string, patch: { name?: string; path?: string }): Project {
    const updated = this.store.updateProject(id, patch);
    if (!updated) throw new Error(`Project '${id}' not found`);
    return updated;
  }

  deleteProject(id: string): void {
    if (!this.store.deleteProject(id)) {
      throw new Error(`Project '${id}' not found`);
    }
  }

  listApprovalRules(projectId?: string): ApprovalRule[] {
    const projectPath = projectId ? this.store.getProject(projectId)?.path : undefined;
    return this.store.listApprovalRules(projectPath);
  }

  deleteApprovalRule(id: string): void {
    if (!this.store.deleteApprovalRule(id)) {
      throw new Error(`Approval rule '${id}' not found`);
    }
  }

  getThread(id: string): ThreadSummary | undefined {
    return this.store.getThread(id);
  }

  listThreads(projectId?: string): ThreadSummary[] {
    return this.store.listThreads(projectId);
  }

  getThreadMessages(threadId: string): StoredMessage[] {
    return this.store.getThreadMessages(threadId);
  }

  ensureSession(id: string): Session | undefined {
    const existing = this.sessions.get(id);
    if (existing) return existing;

    const thread = this.store.getThread(id);
    if (!thread) return undefined;

    return this.hydrateSession(thread);
  }

  createThread(options: {
    cwd?: string;
    projectId?: string;
    mode?: string;
    model?: string;
    providerId?: string;
    modelMode?: string;
    parentId?: string;
    agentProfile?: string;
  }): Session {
    let cwd = options.cwd;
    let projectId = options.projectId;

    if (options.parentId) {
      if (!cwd) {
        const parentSession = this.sessions.get(options.parentId);
        if (parentSession) cwd = parentSession.cwd;
      }
      if (!projectId) {
        const parentThread = this.store.getThread(options.parentId);
        projectId = parentThread?.projectId;
      }
    } else if (projectId) {
      const project = this.store.getProject(projectId);
      if (!project) throw new Error(`Project '${projectId}' not found`);
      cwd = project.path;
    }

    if (!cwd) {
      throw new Error("Project is required to create a thread");
    }
    const providerId =
      options.providerId ?? this.config.default?.provider ?? this.config.providers[0]?.id ?? "deepseek";
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new Error(`Provider '${providerId}' not configured. Set API key in Settings.`);
    }

    const mode = options.mode ?? this.config.default?.mode ?? "agent";
    const model =
      options.model ??
      this.config.default?.model ??
      this.config.providers.find((p) => p.id === providerId)?.default_model ??
      "deepseek-v4-pro";
    const modelMode = options.modelMode ?? defaultModelMode(providerId, model);
    const approvalProjectPath = projectId
      ? this.store.getProject(projectId)?.path ?? cwd
      : cwd;

    const config: SessionConfig = {
      id: randomUUID(),
      cwd,
      mode,
      model,
      modelMode,
      providerId,
      parentId: options.parentId,
      agentProfile: options.agentProfile,
    };

    const policy = new PolicyEngine(mode);
    policy.setApprovalRules(this.store.listApprovalRules(approvalProjectPath));
    const context = new ContextBuilder();

    let maxTurns = 30;
    if (options.agentProfile) {
      const profile = AGENT_PROFILES[options.agentProfile];
      if (profile) {
        maxTurns = profile.maxTurns;
        policy.setMode(profile.mode);
      }
    }

    const maxDepth = this.config.agents?.max_depth ?? 1;
    const activeThreads = this.sessions.size;
    const maxThreads = this.config.agents?.max_threads ?? 6;
    if (activeThreads >= maxThreads) {
      throw new Error(`Maximum thread limit (${maxThreads}) reached`);
    }

    const session = new Session(
      config,
      provider,
      policy,
      this.tools,
      context,
      this.buildSessionOptions(providerId, model, maxTurns, maxDepth, approvalProjectPath),
      options.parentId ? 1 : 0,
    );

    const now = new Date().toISOString();
    const profileLabel = options.agentProfile
      ? options.agentProfile.charAt(0).toUpperCase() + options.agentProfile.slice(1)
      : null;
    this.store.upsertThread({
      id: config.id!,
      title: profileLabel ? `Sub-agent · ${profileLabel}` : "New thread",
      cwd,
      projectId: options.parentId ? undefined : projectId,
      mode,
      model,
      modelMode,
      providerId,
      status: "idle",
      parentId: options.parentId,
      createdAt: now,
      updatedAt: now,
    });

    session.on((event) => this.handleSessionEvent(config.id!, event));

    this.sessions.set(config.id!, session);
    return session;
  }

  private createSubAgent(
    parentId: string,
    subConfig: SubAgentConfig,
    providerId: string,
    model: string,
  ): Session {
    const parent = this.sessions.get(parentId);
    if (!parent) throw new Error("Parent session not found");

    const parentThread = this.store.getThread(parentId);
    const profile = AGENT_PROFILES[subConfig.profile];
    return this.createThread({
      cwd: parent.cwd,
      projectId: parentThread?.projectId,
      mode: profile?.mode ?? "agent",
      model: subConfig.model ?? (subConfig.inheritModel !== false ? model : undefined),
      modelMode: parent.getModelMode(),
      providerId,
      parentId,
      agentProfile: subConfig.profile,
    });
  }

  getSession(id: string): Session | undefined {
    return this.ensureSession(id);
  }

  private hydrateSession(thread: ThreadSummary): Session {
    const providerId =
      thread.providerId ??
      this.config.default?.provider ??
      this.config.providers[0]?.id ??
      "deepseek";
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new Error(`Provider '${providerId}' not configured. Set API key in Settings.`);
    }

    const policy = new PolicyEngine(thread.mode);
    const approvalProjectPath = thread.projectId
      ? this.store.getProject(thread.projectId)?.path ?? thread.cwd
      : thread.cwd;
    policy.setApprovalRules(this.store.listApprovalRules(approvalProjectPath));
    const context = new ContextBuilder();
    const maxTurns = 30;
    const maxDepth = this.config.agents?.max_depth ?? 1;

    const config: SessionConfig = {
      id: thread.id,
      cwd: thread.cwd,
      mode: thread.mode,
      model: thread.model,
      modelMode: thread.modelMode ?? defaultModelMode(providerId, thread.model),
      providerId,
      parentId: thread.parentId,
    };

    const session = new Session(
      config,
      provider,
      policy,
      this.tools,
      context,
      this.buildSessionOptions(providerId, thread.model, maxTurns, maxDepth, approvalProjectPath),
      thread.parentId ? 1 : 0,
    );

    const stored = this.store.getThreadMessages(thread.id);
    if (stored.length > 0) {
      session.restoreHistory(
        sanitizeMessageHistory(stored.map(storedMessageToHistory)),
        thread.title !== "New thread" ? thread.title : undefined,
      );
    }
    session.restoreMemory(this.store.getThreadMemory(thread.id)?.content);

    session.on((event) => this.handleSessionEvent(thread.id, event));
    this.sessions.set(thread.id, session);
    return session;
  }

  respondToApproval(sessionId: string, response: ApprovalResponse): void {
    this.ensureSession(sessionId)?.respondToApproval(response);
  }

  setThreadModelMode(threadId: string, modelMode?: string): void {
    this.sessions.get(threadId)?.setModelMode(modelMode);
    this.store.updateThread(threadId, {
      modelMode: modelMode || undefined,
      updatedAt: new Date().toISOString(),
    });
  }

  getThreadEvents(threadId: string): StoredRunEvent[] {
    return this.store.listRunEvents(threadId);
  }

  listObservations(threadId: string, limit?: number): ObservationRecord[] {
    return this.store.listObservations(threadId, limit);
  }

  getObservation(threadId: string, id: string): ObservationRecord | undefined {
    return this.store.getObservation(threadId, id);
  }

  private buildSessionOptions(
    providerId: string,
    model: string,
    maxTurns: number,
    maxDepth: number,
    approvalProjectPath: string,
  ): AgentEngineOptions {
    return {
      maxTurns,
      maxDepth,
      jobMaxRuntimeSeconds: this.config.agents?.job_max_runtime_seconds ?? 0,
      modelIdleTimeoutMs: secondsToMs(this.config.agents?.model_idle_timeout_seconds ?? 300),
      modelRequestTimeoutMs: secondsToMs(
        this.config.agents?.model_request_timeout_seconds ?? 1800,
      ),
      contextInputTokens: this.config.agents?.context_input_tokens,
      contextOutputReserveTokens: this.config.agents?.context_output_reserve_tokens ?? 64_000,
      contextToolReserveTokens: this.config.agents?.context_tool_reserve_tokens ?? 16_000,
      contextRecentTokens: this.config.agents?.context_recent_tokens ?? 16_000,
      contextWorkingMemoryTokens: this.config.agents?.context_working_memory_tokens ?? 6_000,
      contextObservationTokens: this.config.agents?.context_observation_tokens ?? 24_000,
      contextDynamicTokens: this.config.agents?.context_dynamic_tokens ?? 2_000,
      contextFileEvidenceTokens: this.config.agents?.context_file_evidence_tokens ?? 48_000,
      persistApproval: (input) => this.persistApproval(approvalProjectPath, input),
      recordObservation: (input) => this.store.addObservation(input),
      listObservations: (threadId, limit) => this.store.listObservations(threadId, limit),
      getObservation: (threadId, id) => this.store.getObservation(threadId, id),
      onSpawnSubAgent: (parentId, subConfig) =>
        Promise.resolve(this.createSubAgent(parentId, subConfig, providerId, model)),
    };
  }

  private persistApproval(projectPath: string, input: PersistApprovalInput): ApprovalRule {
    return this.store.addApprovalRule({
      scope: "project",
      projectPath,
      ...input,
    });
  }

  private handleSessionEvent(threadId: string, event: SessionEvent): void {
    const now = new Date().toISOString();
    const logEvent = summarizeSessionEvent(event);
    if (logEvent) {
      this.store.addRunEvent({ threadId, createdAt: now, ...logEvent });
    }

    if (event.type === "turn_complete") {
      this.store.updateThread(threadId, { status: turnResultStatus(event.result), updatedAt: now });
    } else if (event.type === "status_changed") {
      this.store.updateThread(threadId, { status: event.status, updatedAt: now });
    } else if (event.type === "mode_changed") {
      this.store.updateThread(threadId, { mode: event.mode, updatedAt: now });
    }

    if (event.type === "turn_complete") {
      const session = this.sessions.get(threadId);
      const thread = this.store.getThread(threadId);
      if (session && !thread?.parentId) {
        const history = session.getHistory();
        const now = new Date().toISOString();
        this.store.setThreadMessages(
          threadId,
          history.map((msg) => ({
            threadId,
            role: msg.role,
            content: msg.content,
            reasoningContent: msg.reasoning_content,
            toolCalls: msg.tool_calls ? JSON.stringify(msg.tool_calls) : undefined,
            toolCallId: msg.tool_call_id,
            name: msg.name,
            createdAt: now,
          })),
        );
        this.store.updateThread(threadId, {
          title: session.getTitle(),
          updatedAt: now,
        });
        const memory = buildThreadMemory(
          history,
          this.store.listRunEvents(threadId, 80),
        );
        this.store.setThreadMemory(threadId, memory);
        session.restoreMemory(memory);
      }
    }
  }

  subscribe(sessionId: string, listener: (event: SessionEvent) => void): Unsubscribe {
    let session = this.sessions.get(sessionId);
    if (!session) {
      const thread = this.store.getThread(sessionId);
      if (thread) {
        try {
          session = this.hydrateSession(thread);
        } catch {
          return () => {};
        }
      }
    }
    if (!session) return () => {};
    return session.on(listener);
  }
}

function storedMessageToHistory(msg: StoredMessage): Message {
  return {
    role: msg.role as Message["role"],
    content: msg.content,
    reasoning_content: msg.reasoningContent,
    tool_calls: msg.toolCalls ? JSON.parse(msg.toolCalls) : undefined,
    tool_call_id: msg.toolCallId,
    name: msg.name,
  };
}

function secondsToMs(seconds: number): number {
  return Math.max(1, seconds) * 1000;
}

function defaultModelMode(providerId?: string, model?: string): string | undefined {
  const value = `${providerId ?? ""} ${model ?? ""}`.toLocaleLowerCase();
  return value.includes("deepseek") ? "deepseek-high" : undefined;
}

function turnResultStatus(result: { status: "completed" | "error" | "cancelled" }): ThreadSummary["status"] {
  if (result.status === "completed") return "completed";
  if (result.status === "cancelled") return "cancelled";
  return "error";
}

function summarizeSessionEvent(
  event: SessionEvent,
): Omit<StoredRunEvent, "id" | "threadId" | "createdAt"> | null {
  switch (event.type) {
    case "text_delta":
    case "thinking_delta":
    case "mode_changed":
      return null;
    case "status_changed":
      return { type: event.type, status: event.status };
    case "tool_call":
      return {
        type: event.type,
        detail: {
          toolCallId: event.call.id,
          toolName: event.call.function.name,
          argumentsLength: event.call.function.arguments.length,
        },
      };
    case "tool_result":
      return {
        type: event.type,
        status: event.result.isError ? "error" : "completed",
        message: event.result.isError ? event.result.content.slice(0, 500) : undefined,
        detail: {
          toolCallId: event.result.toolCallId,
          toolName: event.result.name,
          contentLength: event.result.content.length,
          observationId: event.result.observationId,
          rawContentLength: event.result.rawContentLength,
          compacted: event.result.compacted,
        },
      };
    case "context_diagnostics":
      return {
        type: event.type,
        detail: {
          estimatedInputTokens: event.diagnostics.estimatedInputTokens,
          inputBudgetTokens: event.diagnostics.inputBudgetTokens,
          maxContextTokens: event.diagnostics.maxContextTokens,
          outputReserveTokens: event.diagnostics.outputReserveTokens,
          toolReserveTokens: event.diagnostics.toolReserveTokens,
          promptTokens: event.diagnostics.promptTokens,
          completionTokens: event.diagnostics.completionTokens,
          totalTokens: event.diagnostics.totalTokens,
          cacheHitTokens: event.diagnostics.cacheHitTokens,
          cacheMissTokens: event.diagnostics.cacheMissTokens,
          suppressedObservationTokens: event.diagnostics.suppressedObservationTokens,
          slots: event.diagnostics.slots,
        },
      };
    case "approval_required":
      return {
        type: event.type,
        status: "waiting",
        detail: {
          requestId: event.requestId,
          toolCallId: event.call.id,
          toolName: event.call.function.name,
          category: event.category,
        },
      };
    case "subagent_spawned":
      return {
        type: event.type,
        detail: {
          childSessionId: event.sessionId,
          profile: event.profile,
          toolCallId: event.toolCallId,
        },
      };
    case "subagent_event":
      return {
        type: event.type,
        detail: {
          childSessionId: event.childSessionId,
          profile: event.profile,
          toolCallId: event.toolCallId,
          eventType: event.event.type,
        },
      };
    case "subagent_completed":
      return {
        type: event.type,
        status: "completed",
        detail: {
          childSessionId: event.sessionId,
          profile: event.profile,
          toolCallId: event.toolCallId,
          resultLength: event.result.length,
        },
      };
    case "turn_complete":
      return {
        type: event.type,
        status: event.result.status,
        message: event.result.error,
        detail: {
          reason: event.result.reason,
          textLength: event.result.text.length,
          toolCallCount: event.result.toolCalls.length,
        },
      };
    case "error":
      return { type: event.type, status: "error", message: event.error };
  }
}

function resolveDataDir(): string {
  const home = homedir();
  return join(home, ".nhicode", "data");
}
