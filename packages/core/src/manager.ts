import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { OpenAICompatibleProvider } from "@nhicode/models";
import { createProvidersFromConfig } from "@nhicode/models";
import { PolicyEngine } from "@nhicode/policy";
import { ToolRegistry } from "@nhicode/tools";
import { ContextBuilder, AGENT_PROFILES } from "@nhicode/context";
import { loadConfig, resolveApiKey } from "@nhicode/shared";
import type {
  ApprovalResponse,
  SessionConfig,
  SessionEvent,
  SubAgentConfig,
  NhiCodeConfig,
  ThreadSummary,
  Unsubscribe,
} from "@nhicode/shared";
import { Session } from "./session.js";
import { JsonStore } from "./store.js";

export interface SessionManagerOptions {
  dataDir?: string;
  apiKeys?: Record<string, string>;
}

export class SessionManager {
  private store: JsonStore;
  private sessions = new Map<string, Session>();
  private providers = new Map<string, OpenAICompatibleProvider>();
  private config: NhiCodeConfig;
  private tools = new ToolRegistry();
  private apiKeys: Record<string, string>;

  constructor(options: SessionManagerOptions = {}) {
    const dataDir = options.dataDir ?? resolveDataDir();
    mkdirSync(dataDir, { recursive: true });
    this.store = new JsonStore(dataDir);
    this.apiKeys = options.apiKeys ?? {};
    this.config = { default: {}, providers: [] };
  }

  async initialize(cwd?: string): Promise<void> {
    this.config = await loadConfig(cwd);
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
  }

  getConfig(): NhiCodeConfig {
    return this.config;
  }

  getProviders(): string[] {
    return Array.from(this.providers.keys());
  }

  listThreads(): ThreadSummary[] {
    return this.store.listThreads();
  }

  createThread(options: {
    cwd: string;
    mode?: string;
    model?: string;
    providerId?: string;
    parentId?: string;
    agentProfile?: string;
  }): Session {
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
      cwd: options.cwd,
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
    this.store.upsertThread({
      id: config.id!,
      title: "New thread",
      cwd: options.cwd,
      mode,
      model,
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

    const profile = AGENT_PROFILES[subConfig.profile];
    return this.createThread({
      cwd: parent.cwd,
      mode: profile?.mode ?? "agent",
      model: subConfig.model ?? (subConfig.inheritModel !== false ? model : undefined),
      providerId,
      parentId,
      agentProfile: subConfig.profile,
    });
  }

  getSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  respondToApproval(sessionId: string, response: ApprovalResponse): void {
    this.sessions.get(sessionId)?.respondToApproval(response);
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
      if (session) {
        const history = session.getHistory();
        const lastMessages = history.slice(-10);
        for (const msg of lastMessages) {
          this.store.addMessage({
            threadId,
            role: msg.role,
            content: msg.content,
            toolCalls: msg.tool_calls ? JSON.stringify(msg.tool_calls) : undefined,
            toolCallId: msg.tool_call_id,
            name: msg.name,
            createdAt: now,
          });
        }
        this.store.updateThread(threadId, {
          title: session.getTitle(),
          updatedAt: now,
        });
      }
    }
  }

  subscribe(sessionId: string, listener: (event: SessionEvent) => void): Unsubscribe {
    const session = this.sessions.get(sessionId);
    if (!session) return () => {};
    return session.on(listener);
  }
}

function resolveDataDir(): string {
  const home = homedir();
  const primary = join(home, ".nhicode", "data");
  const legacy = [
    join(home, ".suprmodl", "data"),
    join(home, ".supermodel", "data"),
  ];
  for (const dir of [primary, ...legacy]) {
    if (existsSync(dir)) return dir;
  }
  return primary;
}
