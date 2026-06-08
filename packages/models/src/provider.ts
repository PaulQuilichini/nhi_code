import OpenAI from "openai";
import type {
  ChatEvent,
  ChatRequest,
  Message,
  ModelCapabilities,
  ModelInfo,
  ModelProviderConfig,
  ToolCall,
} from "@nhicode/shared";
import { sanitizeMessageHistory } from "@nhicode/context";

export interface ModelProvider {
  id: string;
  listModels(): Promise<ModelInfo[]>;
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

  async *chat(request: ChatRequest): AsyncIterable<ChatEvent> {
    const model = request.model || this.defaultModel;
    const [system, dialog] = splitSystemMessages(request.messages);
    const openaiMessages = [
      ...system.map(toOpenAIMessage),
      ...sanitizeMessageHistory(dialog).map(toOpenAIMessage),
    ];

    try {
      const stream = await this.client.chat.completions.create(
        buildStreamParams({
          model,
          messages: openaiMessages,
          tools: request.tools as OpenAI.ChatCompletionTool[] | undefined,
          temperature: request.temperature,
          maxTokens: request.maxTokens,
          generationConfig: this.generationConfig,
        }),
        { signal: request.signal },
      );

      let fullContent = "";
      let fullThinking = "";
      const toolCalls: Map<number, { id: string; name: string; arguments: string }> = new Map();
      let doneEmitted = false;

      for await (const chunk of stream) {
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

        if (choice.finish_reason && !doneEmitted) {
          doneEmitted = true;
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

          yield {
            type: "done",
            message,
            usage: chunk.usage
              ? {
                  promptTokens: chunk.usage.prompt_tokens ?? 0,
                  completionTokens: chunk.usage.completion_tokens ?? 0,
                  totalTokens: chunk.usage.total_tokens ?? 0,
                }
              : undefined,
          };
        }
      }
    } catch (err) {
      if (request.signal?.aborted) {
        yield { type: "error", error: "Request cancelled" };
        return;
      }
      yield { type: "error", error: err instanceof Error ? err.message : String(err) };
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

function buildStreamParams(opts: {
  model: string;
  messages: OpenAI.ChatCompletionMessageParam[];
  tools?: OpenAI.ChatCompletionTool[];
  temperature?: number;
  maxTokens?: number;
  generationConfig: Record<string, unknown>;
}): OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming {
  const { thinking, reasoning_effort, enable_thinking, ...rest } = opts.generationConfig;

  return {
    model: opts.model,
    messages: opts.messages,
    stream: true,
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    ...(opts.tools?.length ? { tools: opts.tools } : {}),
    ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
    ...rest,
    ...(reasoning_effort !== undefined ? { reasoning_effort } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
    ...(enable_thinking !== undefined ? { enable_thinking } : {}),
  } as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;
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

function toOpenAIMessage(msg: Message): OpenAI.ChatCompletionMessageParam {
  const reasoning = msg.reasoning_content
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
          content: msg.content ?? null,
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
