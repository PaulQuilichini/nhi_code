import OpenAI from "openai";
import type {
  ChatEvent,
  ChatRequest,
  Message,
  ModelCapabilities,
  ModelInfo,
  ModelProviderConfig,
  TokenUsage,
  TurnStopReason,
  ToolCall,
} from "@nhicode/shared";
import { sanitizeMessageHistory } from "@nhicode/context";

export interface ModelProvider {
  id: string;
  listModels(): Promise<ModelInfo[]>;
  getModelInfo(model?: string): ModelInfo;
  chat(request: ChatRequest): AsyncIterable<ChatEvent>;
  estimateTokens(messages: Message[]): Promise<number>;
  capabilities: ModelCapabilities;
}

const KNOWN_MODELS: Record<string, Partial<ModelInfo>> = {
  "deepseek-v4-pro": {
    name: "DeepSeek V4 Pro",
    maxContext: 1_000_000,
    maxOutput: 384_000,
    capabilities: { toolCalling: true, thinking: true, streaming: true },
  },
  "deepseek-v4-flash": {
    name: "DeepSeek V4 Flash",
    maxContext: 1_000_000,
    maxOutput: 128_000,
    capabilities: { toolCalling: true, thinking: true, streaming: true },
  },
  "kimi-k2.5": {
    name: "Kimi K2.5",
    maxContext: 256_000,
    maxOutput: 32_000,
    capabilities: { toolCalling: true, thinking: true, streaming: true },
  },
  "kimi-k2.6": {
    name: "Kimi K2.6",
    maxContext: 256_000,
    maxOutput: 32_000,
    capabilities: { toolCalling: true, thinking: true, streaming: true },
  },
  "kimi-for-coding": {
    name: "Kimi Code",
    maxContext: 256_000,
    maxOutput: 32_000,
    capabilities: { toolCalling: true, thinking: true, streaming: true },
  },
  "qwen3-coder-plus": {
    name: "Qwen3 Coder Plus",
    maxContext: 256_000,
    maxOutput: 32_000,
    capabilities: { toolCalling: true, thinking: true, streaming: true },
  },
  "qwen3-coder-next": {
    name: "Qwen3 Coder Next",
    maxContext: 256_000,
    maxOutput: 32_000,
    capabilities: { toolCalling: true, thinking: true, streaming: true },
  },
};

const DEFAULT_IDLE_TIMEOUT_MS = 300_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 1_800_000;

export class OpenAICompatibleProvider implements ModelProvider {
  readonly id: string;
  readonly capabilities: ModelCapabilities;
  private client: OpenAI;
  private defaultModel: string;
  private generationConfig: Record<string, unknown>;
  private providerLabel: string;

  constructor(config: ModelProviderConfig, providerLabel?: string) {
    this.id = config.id;
    this.defaultModel = config.defaultModel;
    this.generationConfig = config.generationConfig ?? {};
    this.providerLabel = providerLabel ?? config.id;
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
    });
    const known = KNOWN_MODELS[config.defaultModel];
    this.capabilities = known?.capabilities ?? {
      toolCalling: true,
      thinking: false,
      streaming: true,
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const response = await this.client.models.list();
      return response.data.map((m) => {
        const known = KNOWN_MODELS[m.id];
        return {
          id: m.id,
          name: known?.name ?? m.id,
          provider: this.providerLabel,
          maxContext: known?.maxContext ?? 128_000,
          maxOutput: known?.maxOutput ?? 16_000,
          capabilities: known?.capabilities ?? this.capabilities,
        };
      });
    } catch {
      return Object.entries(KNOWN_MODELS)
        .filter(([id]) => matchesProviderModel(this.providerLabel, id))
        .map(([id, info]) => ({
          id,
          name: info.name ?? id,
          provider: this.providerLabel,
          maxContext: info.maxContext ?? 128_000,
          maxOutput: info.maxOutput ?? 16_000,
          capabilities: info.capabilities ?? this.capabilities,
        }));
    }
  }

  getModelInfo(model = this.defaultModel): ModelInfo {
    const known = KNOWN_MODELS[model];
    return {
      id: model,
      name: known?.name ?? model,
      provider: this.providerLabel,
      maxContext: known?.maxContext ?? 128_000,
      maxOutput: known?.maxOutput ?? 16_000,
      capabilities: known?.capabilities ?? this.capabilities,
    };
  }

  async *chat(request: ChatRequest): AsyncIterable<ChatEvent> {
    const model = request.model || this.defaultModel;
    const generationConfig = {
      ...this.generationConfig,
      ...(request.generationConfig ?? {}),
    };
    const deepSeekThinking = isDeepSeekThinkingMode(
      this.providerLabel,
      model,
      generationConfig,
    );
    const [system, dialog] = splitSystemMessages(request.messages);
    const openaiMessages = [
      ...system.map((msg) => toOpenAIMessage(msg, { deepSeekThinking })),
      ...sanitizeMessageHistory(dialog).map((msg) =>
        toOpenAIMessage(msg, { deepSeekThinking }),
      ),
    ];
    const idleTimeoutMs =
      request.idleTimeoutMs ??
      numberConfig(generationConfig, ["model_idle_timeout_ms", "idle_timeout_ms"]) ??
      DEFAULT_IDLE_TIMEOUT_MS;
    const requestTimeoutMs =
      request.requestTimeoutMs ??
      numberConfig(generationConfig, ["model_request_timeout_ms", "request_timeout_ms"]) ??
      DEFAULT_REQUEST_TIMEOUT_MS;
    const abort = createTimeoutAbort(request.signal, idleTimeoutMs, requestTimeoutMs);

    try {
      abort.start();
      const stream = await this.client.chat.completions.create(
        buildStreamParams({
          model,
          messages: openaiMessages,
          tools: request.tools as OpenAI.ChatCompletionTool[] | undefined,
          temperature: request.temperature,
          maxTokens: request.maxTokens,
          generationConfig,
          providerLabel: this.providerLabel,
        }),
        { signal: abort.signal },
      );

      let fullContent = "";
      let fullThinking = "";
      const toolCalls: Map<number, { id: string; name: string; arguments: string }> = new Map();
      let finishedMessage: Message | null = null;
      let finishReason: string | undefined;
      let latestUsage: TokenUsage | undefined;

      for await (const chunk of stream) {
        abort.touch();
        latestUsage = usageFromChunk(chunk.usage, latestUsage);
        const choice = chunk.choices[0];
        if (!choice) continue;

        const delta = choice.delta;

        // Reasoning/thinking content (DeepSeek V4, Qwen)
        const reasoning = (delta as Record<string, unknown>).reasoning_content;
        if (typeof reasoning === "string" && reasoning) {
          const thinkingUpdate = appendStreamDelta(fullThinking, reasoning);
          if (thinkingUpdate.increment) {
            fullThinking = thinkingUpdate.next;
            yield { type: "thinking_delta", content: thinkingUpdate.increment };
          }
        }

        if (delta.content) {
          const textUpdate = appendStreamDelta(fullContent, delta.content);
          if (textUpdate.increment) {
            fullContent = textUpdate.next;
            yield { type: "text_delta", content: textUpdate.increment };
          }
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!toolCalls.has(idx)) {
              toolCalls.set(idx, { id: tc.id ?? "", name: tc.function?.name ?? "", arguments: "" });
            }
            const existing = toolCalls.get(idx)!;
            if (tc.id) existing.id = tc.id;
            if (tc.function?.name) existing.name = tc.function.name;
            if (tc.function?.arguments) existing.arguments += tc.function.arguments;

            yield {
              type: "tool_call_delta",
              index: idx,
              id: tc.id,
              name: tc.function?.name,
              arguments: tc.function?.arguments,
            };
          }
        }

        if (choice.finish_reason && !finishedMessage) {
          const messageToolCalls: ToolCall[] = Array.from(toolCalls.entries())
            .sort(([a], [b]) => a - b)
            .map(([, tc]) => ({
              id: tc.id || `call_${Date.now()}`,
              type: "function" as const,
              function: { name: tc.name, arguments: tc.arguments },
            }));

          const message: Message = {
            role: "assistant",
            content: fullContent || (messageToolCalls.length > 0 ? null : ""),
            reasoning_content:
              fullThinking && messageToolCalls.length > 0 ? fullThinking : undefined,
            tool_calls: messageToolCalls.length > 0 ? messageToolCalls : undefined,
          };
          finishedMessage = message;
          finishReason = choice.finish_reason;
        }
      }

      if (finishedMessage) {
        yield {
          type: "done",
          message: finishedMessage,
          finishReason,
          usage: latestUsage,
        };
      } else {
        yield {
          type: "error",
          reason: "stream_incomplete",
          error: "Model stream ended before the provider sent a finish reason.",
        };
      }
    } catch (err) {
      const timeout = abort.getTimeout();
      if (timeout) {
        yield { type: "error", reason: timeout.reason, error: timeout.message };
        return;
      }
      if (request.signal?.aborted) {
        yield { type: "error", reason: "cancelled", error: "Request cancelled" };
        return;
      }
      yield {
        type: "error",
        reason: "provider_error",
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      abort.dispose();
    }
  }

  async estimateTokens(messages: Message[]): Promise<number> {
    const text = messages.map((m) => m.content ?? "").join(" ");
    return Math.ceil(text.length / 4);
  }
}

function appendStreamDelta(
  buffer: string,
  chunk: string,
): { next: string; increment: string | null } {
  if (!chunk) return { next: buffer, increment: null };
  if (!buffer) return { next: chunk, increment: chunk };
  if (chunk.length >= buffer.length && chunk.startsWith(buffer)) {
    return { next: chunk, increment: chunk.slice(buffer.length) };
  }
  if (chunk === buffer || buffer.endsWith(chunk)) {
    return { next: buffer, increment: null };
  }
  if (chunk.startsWith(buffer)) {
    return { next: chunk, increment: chunk.slice(buffer.length) };
  }
  return { next: buffer + chunk, increment: chunk };
}

function usageFromChunk(usage: unknown, previous?: TokenUsage): TokenUsage | undefined {
  if (!usage || typeof usage !== "object") return previous;
  const value = usage as Record<string, unknown>;
  const promptTokens = numberField(value.prompt_tokens) ?? previous?.promptTokens ?? 0;
  const completionTokens =
    numberField(value.completion_tokens) ?? previous?.completionTokens ?? 0;
  const totalTokens = numberField(value.total_tokens) ?? previous?.totalTokens ?? 0;
  const promptDetails = objectField(value.prompt_tokens_details);
  const completionDetails = objectField(value.completion_tokens_details);

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cachedTokens:
      numberField(promptDetails?.cached_tokens) ??
      numberField(value.cached_tokens) ??
      previous?.cachedTokens,
    promptCacheHitTokens:
      numberField(value.prompt_cache_hit_tokens) ??
      numberField(promptDetails?.cached_tokens) ??
      previous?.promptCacheHitTokens,
    promptCacheMissTokens:
      numberField(value.prompt_cache_miss_tokens) ?? previous?.promptCacheMissTokens,
    reasoningTokens:
      numberField(completionDetails?.reasoning_tokens) ??
      numberField(value.reasoning_tokens) ??
      previous?.reasoningTokens,
  };
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function objectField(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function buildStreamParams(opts: {
  model: string;
  messages: OpenAI.ChatCompletionMessageParam[];
  tools?: OpenAI.ChatCompletionTool[];
  temperature?: number;
  maxTokens?: number;
  generationConfig: Record<string, unknown>;
  providerLabel: string;
}): OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming {
  const deepSeekThinking = isDeepSeekThinkingMode(
    opts.providerLabel,
    opts.model,
    opts.generationConfig,
  );
  const generationConfig = deepSeekThinking
    ? stripDeepSeekThinkingSampling(opts.generationConfig)
    : opts.generationConfig;
  const { thinking, reasoning_effort, enable_thinking, ...rest } =
    stripProviderRuntimeConfig(generationConfig);

  return {
    model: opts.model,
    messages: opts.messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(!deepSeekThinking && opts.temperature !== undefined
      ? { temperature: opts.temperature }
      : {}),
    ...(opts.tools?.length ? { tools: opts.tools } : {}),
    ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
    ...rest,
    ...(reasoning_effort !== undefined ? { reasoning_effort } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
    ...(enable_thinking !== undefined ? { enable_thinking } : {}),
  } as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;
}

function stripProviderRuntimeConfig(config: Record<string, unknown>): Record<string, unknown> {
  const result = { ...config };
  delete result.idle_timeout_ms;
  delete result.request_timeout_ms;
  delete result.model_idle_timeout_ms;
  delete result.model_request_timeout_ms;
  return result;
}

function stripDeepSeekThinkingSampling(config: Record<string, unknown>): Record<string, unknown> {
  const result = { ...config };
  delete result.temperature;
  delete result.top_p;
  delete result.frequency_penalty;
  delete result.presence_penalty;
  return result;
}

function numberConfig(config: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = config[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

function createTimeoutAbort(
  upstream: AbortSignal | undefined,
  idleTimeoutMs: number,
  requestTimeoutMs: number,
) {
  const controller = new AbortController();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let requestTimer: ReturnType<typeof setTimeout> | undefined;
  let timeout:
    | { reason: Extract<TurnStopReason, "model_timeout">; message: string }
    | undefined;

  const abortFromUpstream = () => {
    if (!controller.signal.aborted) controller.abort();
  };

  const clearIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
  };

  const armIdle = () => {
    clearIdle();
    idleTimer = setTimeout(() => {
      timeout = {
        reason: "model_timeout",
        message: `Model stream was idle for ${Math.round(idleTimeoutMs / 1000)} seconds.`,
      };
      controller.abort();
    }, idleTimeoutMs);
  };

  return {
    signal: controller.signal,
    start() {
      if (upstream?.aborted) {
        abortFromUpstream();
        return;
      }
      upstream?.addEventListener("abort", abortFromUpstream, { once: true });
      requestTimer = setTimeout(() => {
        timeout = {
          reason: "model_timeout",
          message: `Model request exceeded ${Math.round(requestTimeoutMs / 1000)} seconds.`,
        };
        controller.abort();
      }, requestTimeoutMs);
      armIdle();
    },
    touch() {
      if (!controller.signal.aborted) armIdle();
    },
    getTimeout() {
      return timeout;
    },
    dispose() {
      clearIdle();
      if (requestTimer) clearTimeout(requestTimer);
      requestTimer = undefined;
      upstream?.removeEventListener("abort", abortFromUpstream);
    },
  };
}

function splitSystemMessages(messages: Message[]): [Message[], Message[]] {
  const system: Message[] = [];
  const rest: Message[] = [];
  for (const msg of messages) {
    if (msg.role === "system") system.push(msg);
    else rest.push(msg);
  }
  return [system, rest];
}

function toOpenAIMessage(
  msg: Message,
  opts: { deepSeekThinking?: boolean } = {},
): OpenAI.ChatCompletionMessageParam {
  const reasoning = shouldSendReasoningContent(msg, opts.deepSeekThinking)
    ? { reasoning_content: msg.reasoning_content }
    : {};
  switch (msg.role) {
    case "system":
      return { role: "system", content: msg.content ?? "" };
    case "user":
      return { role: "user", content: msg.content ?? "" };
    case "assistant":
      if (msg.tool_calls?.length) {
        return {
          role: "assistant",
          content: opts.deepSeekThinking ? msg.content ?? "" : msg.content ?? null,
          ...reasoning,
          tool_calls: msg.tool_calls.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: { name: tc.function.name, arguments: tc.function.arguments },
          })),
        } as unknown as OpenAI.ChatCompletionMessageParam;
      }
      return {
        role: "assistant",
        content: msg.content ?? "",
        ...reasoning,
      } as unknown as OpenAI.ChatCompletionMessageParam;
    case "tool":
      return {
        role: "tool",
        content: msg.content ?? "",
        tool_call_id: msg.tool_call_id ?? "",
        ...(msg.name ? { name: msg.name } : {}),
      };
  }
}

function shouldSendReasoningContent(
  msg: Message,
  deepSeekThinking?: boolean,
): msg is Message & { reasoning_content: string } {
  if (!msg.reasoning_content) return false;
  if (!deepSeekThinking) return true;
  return msg.role === "assistant" && Boolean(msg.tool_calls?.length);
}

function isDeepSeekThinkingMode(
  providerLabel: string,
  model: string,
  generationConfig: Record<string, unknown>,
): boolean {
  if (!isDeepSeekModel(providerLabel, model)) return false;
  const thinking = generationConfig.thinking;
  if (thinking === true) return true;
  if (thinking && typeof thinking === "object" && !Array.isArray(thinking)) {
    const type = (thinking as Record<string, unknown>).type;
    return type !== "disabled";
  }
  return typeof generationConfig.reasoning_effort === "string";
}

function isDeepSeekModel(providerLabel: string, model: string): boolean {
  const provider = providerLabel.toLowerCase();
  const modelId = model.toLowerCase();
  return provider.includes("deepseek") || modelId.startsWith("deepseek-");
}

function matchesProviderModel(providerLabel: string, modelId: string): boolean {
  if (providerLabel === "deepseek") return modelId.startsWith("deepseek-");
  if (providerLabel === "kimi") return modelId.startsWith("kimi-k2");
  if (providerLabel === "kimi-code") return modelId === "kimi-for-coding";
  if (providerLabel === "qwen") return modelId.startsWith("qwen");
  return modelId.startsWith(providerLabel) || modelId.includes(providerLabel);
}

export function createProvider(
  config: ModelProviderConfig,
): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider(config);
}

export function createProvidersFromConfig(
  providers: Array<{
    id: string;
    base_url: string;
    api_key: string;
    default_model: string;
    generation_config?: Record<string, unknown>;
  }>,
): Map<string, OpenAICompatibleProvider> {
  const map = new Map<string, OpenAICompatibleProvider>();
  for (const p of providers) {
    map.set(
      p.id,
      createProvider({
        id: p.id,
        type: "openai-compatible",
        baseUrl: p.base_url,
        apiKey: p.api_key,
        defaultModel: p.default_model,
        generationConfig: p.generation_config,
      }),
    );
  }
  return map;
}
