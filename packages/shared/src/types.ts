import { z } from "zod";

// ─── Messages & Tool Calls ─────────────────────────────────────────────────

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
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
  stream?: boolean;
}

export type ChatEvent =
  | { type: "text_delta"; content: string }
  | { type: "thinking_delta"; content: string }
  | { type: "tool_call_delta"; index: number; id?: string; name?: string; arguments?: string }
  | { type: "done"; message: Message; usage?: TokenUsage }
  | { type: "error"; error: string };

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
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

// ─── Sessions & Events ───────────────────────────────────────────────────────

export type SessionStatus = "idle" | "running" | "waiting_approval" | "completed" | "error" | "cancelled";

export interface SessionConfig {
  id?: string;
  cwd: string;
  mode: string;
  model: string;
  providerId: string;
  parentId?: string;
  agentProfile?: string;
}

export interface SubAgentConfig {
  profile: string;
  task: string;
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
  status: "completed" | "error" | "cancelled";
  error?: string;
}

export type SessionEvent =
  | { type: "text_delta"; content: string }
  | { type: "thinking_delta"; content: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "tool_result"; result: ToolResult }
  | { type: "approval_required"; call: ToolCall; scopes: ApprovalScope[]; requestId: string }
  | { type: "mode_changed"; mode: string }
  | { type: "subagent_spawned"; sessionId: string; profile: string }
  | { type: "subagent_completed"; sessionId: string; result: string }
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
      max_depth: z.number().optional(),
      job_max_runtime_seconds: z.number().optional(),
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

export interface ThreadSummary {
  id: string;
  title: string;
  cwd: string;
  mode: string;
  model: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  parentId?: string;
}

export interface ApprovalRequest {
  requestId: string;
  sessionId: string;
  toolCall: ToolCall;
  scopes: ApprovalScope[];
}

export interface ApprovalResponse {
  requestId: string;
  decision: "approve_once" | "approve_session" | "approve_project" | "deny";
}
