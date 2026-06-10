import { z } from "zod";

// ─── Messages & Tool Calls ─────────────────────────────────────────────────

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  reasoning_content?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolResult {
  toolCallId: string;
  name: string;
  content: string;
  isError?: boolean;
  observationId?: string;
  rawContentLength?: number;
  compacted?: boolean;
}

// ─── Model Provider ──────────────────────────────────────────────────────────

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  maxContext: number;
  maxOutput: number;
  capabilities: ModelCapabilities;
}

export interface ModelCapabilities {
  toolCalling: boolean;
  thinking: boolean;
  streaming: boolean;
}

export interface ChatRequest {
  model: string;
  messages: Message[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  generationConfig?: Record<string, unknown>;
  stream?: boolean;
  idleTimeoutMs?: number;
  requestTimeoutMs?: number;
  signal?: AbortSignal;
}

export type TurnStopReason =
  | "cancelled"
  | "job_timeout"
  | "max_turns_exceeded"
  | "model_output_limit"
  | "model_timeout"
  | "provider_error"
  | "session_error"
  | "stream_incomplete";

export type ChatEvent =
  | { type: "text_delta"; content: string }
  | { type: "thinking_delta"; content: string }
  | { type: "tool_call_delta"; index: number; id?: string; name?: string; arguments?: string }
  | { type: "done"; message: Message; usage?: TokenUsage; finishReason?: string }
  | { type: "error"; error: string; reason?: TurnStopReason };

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens?: number;
  promptCacheHitTokens?: number;
  promptCacheMissTokens?: number;
  reasoningTokens?: number;
}

export interface ModelProviderConfig {
  id: string;
  type: "openai-compatible";
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  generationConfig?: Record<string, unknown>;
}

// ─── Policy ──────────────────────────────────────────────────────────────────

export type SandboxProfile = "read-only" | "workspace-write" | "full-access";
export type ApprovalPolicy = "always" | "on-request" | "never";

export type PolicyDecision =
  | { action: "allow" }
  | { action: "deny"; reason: string }
  | { action: "ask"; scopes: ApprovalScope[] };

export type ApprovalScope = "once" | "session" | "project";

/** Groups tools into categories for broader approval. */
export type ApprovalCategory = "file" | "shell" | "git" | "web" | "agent";

export const TOOL_CATEGORY: Record<string, ApprovalCategory> = {
  read_file: "file",
  write_file: "file",
  edit_file: "file",
  glob: "file",
  grep: "file",
  list_dir: "file",
  shell: "shell",
  git_status: "git",
  git_diff: "git",
  git_commit: "git",
  spawn_subagent: "agent",
  expand_observation: "agent",
  promote_context: "agent",
  drop_context: "agent",
  summarize_phase: "agent",
};

export const CATEGORY_LABEL: Record<ApprovalCategory, string> = {
  file: "File operations",
  shell: "Shell commands",
  git: "Git operations",
  web: "Web access",
  agent: "Agent controls",
};

export interface ModeProfile {
  name: string;
  description: string;
  sandbox: SandboxProfile;
  approval: ApprovalPolicy;
  allowedTools?: string[];
  deniedTools?: string[];
  systemAddendum?: string;
}

export interface AgentProfile {
  name: string;
  description: string;
  mode: string;
  model?: string;
  systemPrompt?: string;
  maxTurns?: number;
}

export interface PolicyRule {
  tool?: string;
  pattern?: string;
  path?: string;
  action?: "allow" | "deny" | "auto_approve" | "require_approval" | "deny_write";
}

export type ApprovalRuleKind = "tool" | "category" | "shell_prefix";

export interface ApprovalRule {
  id: string;
  scope: "project";
  projectPath: string;
  kind: ApprovalRuleKind;
  toolName?: string;
  category?: ApprovalCategory;
  prefix?: string;
  createdAt: string;
  lastUsedAt?: string;
}

// ─── Sessions & Events ───────────────────────────────────────────────────────

export type SessionStatus = "idle" | "running" | "waiting_approval" | "completed" | "error" | "cancelled";

export interface SessionConfig {
  id?: string;
  cwd: string;
  mode: string;
  model: string;
  providerId: string;
  modelMode?: string;
  contextBudgetTier?: ContextBudgetTier;
  agentCarefulness?: AgentCarefulness;
  parentId?: string;
  agentProfile?: string;
}

export interface SubAgentConfig {
  profile: string;
  task: string;
  toolCallId?: string;
  inheritPolicy?: boolean;
  inheritCwd?: boolean;
  inheritModel?: boolean;
  model?: string;
}

export interface TurnResult {
  text: string;
  thinking?: string;
  toolCalls: ToolCall[];
  usage?: TokenUsage;
  contextDiagnostics?: ContextDiagnostics;
  status: "completed" | "error" | "cancelled";
  error?: string;
  reason?: TurnStopReason;
}

export type SessionEvent =
  | { type: "text_delta"; content: string }
  | { type: "thinking_delta"; content: string }
  | { type: "queued_prompt_started"; promptId: string; text: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "tool_result"; result: ToolResult }
  | { type: "context_diagnostics"; diagnostics: ContextDiagnostics }
  | { type: "approval_required"; call: ToolCall; scopes: ApprovalScope[]; requestId: string; category: ApprovalCategory }
  | { type: "mode_changed"; mode: string }
  | { type: "subagent_spawned"; sessionId: string; profile: string; task: string; toolCallId: string }
  | { type: "subagent_event"; childSessionId: string; profile: string; toolCallId: string; event: SessionEvent }
  | { type: "subagent_completed"; sessionId: string; profile: string; toolCallId: string; result: string }
  | { type: "status_changed"; status: SessionStatus }
  | { type: "turn_complete"; result: TurnResult }
  | { type: "error"; error: string };

export type Unsubscribe = () => void;

// ─── Config Schema ───────────────────────────────────────────────────────────

export const ProviderConfigSchema = z.object({
  id: z.string(),
  type: z.literal("openai-compatible").default("openai-compatible"),
  base_url: z.string().url(),
  api_key_env: z.string().optional(),
  api_key: z.string().optional(),
  default_model: z.string(),
  generation_config: z.record(z.unknown()).optional(),
});

export const NhiCodeConfigSchema = z.object({
  default: z
    .object({
      model: z.string().optional(),
      mode: z.string().optional(),
      provider: z.string().optional(),
      context_budget_tier: z.enum(["compact", "long", "full"]).optional(),
    })
    .optional(),
  providers: z.array(ProviderConfigSchema).default([]),
  policy: z
    .object({
      default_profile: z.enum(["read-only", "workspace-write", "full-access"]).optional(),
      default_approval: z.enum(["always", "on-request", "never"]).optional(),
    })
    .optional(),
  agents: z
    .object({
      max_threads: z.number().optional(),
      max_turns: z.number().optional(),
      max_depth: z.number().optional(),
      job_max_runtime_seconds: z.number().optional(),
      model_idle_timeout_seconds: z.number().optional(),
      model_request_timeout_seconds: z.number().optional(),
      shell_timeout_seconds: z.number().optional(),
      context_input_tokens: z.number().optional(),
      context_output_reserve_tokens: z.number().optional(),
      context_tool_reserve_tokens: z.number().optional(),
      context_recent_tokens: z.number().optional(),
      context_working_memory_tokens: z.number().optional(),
      context_observation_tokens: z.number().optional(),
      context_dynamic_tokens: z.number().optional(),
      context_budget_tier: z.enum(["compact", "long", "full"]).optional(),
    })
    .optional(),
  windows: z
    .object({
      sandbox: z.enum(["elevated", "unelevated"]).optional(),
    })
    .optional(),
  darwin: z
    .object({
      sandbox: z.enum(["seatbelt", "none"]).optional(),
    })
    .optional(),
});

export type NhiCodeConfig = z.infer<typeof NhiCodeConfigSchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  updatedAt: string;
}

export interface ThreadSummary {
  id: string;
  title: string;
  cwd: string;
  projectId?: string;
  mode: string;
  model: string;
  modelMode?: string;
  contextBudgetTier?: ContextBudgetTier;
  agentCarefulness?: AgentCarefulness;
  providerId?: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  parentId?: string;
}

export type ContextBudgetTier = "compact" | "long" | "full";
export type AgentCarefulness = "standard" | "codex";

export interface ApprovalRequest {
  requestId: string;
  sessionId: string;
  toolCall: ToolCall;
  scopes: ApprovalScope[];
  category: ApprovalCategory;
}

export interface ApprovalResponse {
  requestId: string;
  decision:
    | "approve_once"
    | "approve_session"
    | "approve_project"
    | "approve_shell_prefix_project"
    | "approve_category_session"
    | "approve_category_project"
    | "deny";
  category?: ApprovalCategory;
  shellPrefix?: string;
}

export type ObservationKind =
  | "file_read"
  | "file_write"
  | "file_edit"
  | "search"
  | "shell"
  | "git"
  | "subagent"
  | "other";

export interface ObservationRecord {
  id: string;
  threadId: string;
  toolCallId: string;
  toolName: string;
  kind: ObservationKind;
  summary: string;
  content: string;
  compactContent: string;
  isError?: boolean;
  metadata?: Record<string, unknown>;
  tokenEstimate: number;
  rawTokenEstimate: number;
  createdAt: string;
}

export interface QueuedPrompt {
  id: string;
  threadId: string;
  text: string;
  createdAt: string;
}

export type ContextSlotName =
  | "stable_prefix"
  | "working_memory"
  | "recent_history"
  | "observations"
  | "dynamic_state"
  | "user_request";

export interface ContextSlotDiagnostics {
  name: ContextSlotName;
  tokens: number;
  budgetTokens?: number;
  messageCount: number;
  truncated?: boolean;
}

export interface ContextDiagnostics {
  threadId?: string;
  model?: string;
  providerId?: string;
  contextBudgetTier?: ContextBudgetTier;
  createdAt: string;
  estimatedInputTokens: number;
  adjustedInputTokens?: number;
  estimatedToolTokens?: number;
  inputBudgetTokens: number;
  maxContextTokens: number;
  outputReserveTokens: number;
  toolReserveTokens: number;
  tokenSafetyFactor?: number;
  promptInflationFactor?: number;
  promptCeilingTokens?: number;
  hardPromptCeilingTokens?: number;
  compactionCount?: number;
  modelTurnsSinceCompaction?: number;
  toolCallsSinceCompaction?: number;
  suppressedObservationTokens: number;
  cacheHitTokens?: number;
  cacheMissTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  slots: ContextSlotDiagnostics[];
}
