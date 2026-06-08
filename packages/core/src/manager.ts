import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { OpenAICompatibleProvider } from "@nhicode/models";
import { createProvidersFromConfig } from "@nhicode/models";
import { PolicyEngine } from "@nhicode/policy";
import { ToolRegistry } from "@nhicode/tools";
import { ContextBuilder, AGENT_PROFILES, sanitizeMessageHistory } from "@nhicode/context";
import { loadConfig, resolveApiKey } from "@nhicode/shared";
import type {
  ApprovalResponse,
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
import { JsonStore } from "./store.js";
import { ApiKeyStore } from "./keys.js";
import type { StoredMessage } from "./store.js";

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

    const config: SessionConfig = {
      id: randomUUID(),
      cwd,
      mode,
      model,
      providerId,
      parentId: options.parentId,
      agentProfile: options.agentProfile,
    };

    const policy = new PolicyEngine(mode);
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
      {
        maxTurns,
        maxDepth,
        onSpawnSubAgent: (parentId, subConfig) =>
          Promise.resolve(this.createSubAgent(parentId, subConfig, providerId, model)),
      },
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
    const context = new ContextBuilder();
    const maxTurns = 30;
    const maxDepth = this.config.agents?.max_depth ?? 1;

    const config: SessionConfig = {
      id: thread.id,
      cwd: thread.cwd,
      mode: thread.mode,
      model: thread.model,
      providerId,
      parentId: thread.parentId,
    };

    const session = new Session(
      config,
      provider,
      policy,
      this.tools,
      context,
      {
        maxTurns,
        maxDepth,
        onSpawnSubAgent: (parentId, subConfig) =>
          Promise.resolve(this.createSubAgent(parentId, subConfig, providerId, thread.model)),
      },
      thread.parentId ? 1 : 0,
    );

    const stored = this.store.getThreadMessages(thread.id);
    if (stored.length > 0) {
      session.restoreHistory(
        sanitizeMessageHistory(stored.map(storedMessageToHistory)),
        thread.title !== "New thread" ? thread.title : undefined,
      );
    }

    session.on((event) => this.handleSessionEvent(thread.id, event));
    this.sessions.set(thread.id, session);
    return session;
  }

  respondToApproval(sessionId: string, response: ApprovalResponse): void {
    this.ensureSession(sessionId)?.respondToApproval(response);
  }

  private handleSessionEvent(threadId: string, event: SessionEvent): void {
    const now = new Date().toISOString();

    if (event.type === "turn_complete") {
      this.store.updateThread(threadId, { status: "completed", updatedAt: now });
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

function resolveDataDir(): string {
  const home = homedir();
  return join(home, ".nhicode", "data");
}
