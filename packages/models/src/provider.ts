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
  "deepseek-v4-r1": {
    name: "DeepSeek V4 R1",
    maxContext: 1_000_000,
    maxOutput: 384_000,
    capabilities: { toolCalling: true, thinking: true, streaming: true },
  },
  "kimi-k2.5": {
    name: "Kimi K2.5",
    maxContext: 256_000,
    maxOutput: 32_000,
    capabilities: { toolCalling: true, thinking: false, streaming: true },
  },
  "kimi-k2.6": {
    name: "Kimi K2.6",
    maxContext: 256_000,
    maxOutput: 32_000,
    capabilities: { toolCalling: true, thinking: false, streaming: true },
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
        .filter(([id]) => id.includes(this.providerLabel) || this.providerLabel === "custom")
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
    const openaiMessages = request.messages.map(toOpenAIMessage);

    try {
      const stream = await this.client.chat.completions.create({
        model,
        messages: openaiMessages,
        tools: request.tools as OpenAI.ChatCompletionTool[] | undefined,
        temperature: request.temperature ?? 0.2,
        max_tokens: request.maxTokens,
        stream: true,
        ...this.generationConfig,
      });

      let fullContent = "";
      let fullThinking = "";
      const toolCalls: Map<number, { id: string; name: string; arguments: string }> = new Map();

      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        if (!choice) continue;

        const delta = choice.delta;

        // Reasoning/thinking content (DeepSeek, Qwen)
        const reasoning = (delta as Record<string, unknown>).reasoning_content;
        if (typeof reasoning === "string" && reasoning) {
          fullThinking += reasoning;
          yield { type: "thinking_delta", content: reasoning };
        }

        if (delta.content) {
          fullContent += delta.content;
          yield { type: "text_delta", content: delta.content };
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

        if (choice.finish_reason) {
          const messageToolCalls: ToolCall[] = Array.from(toolCalls.entries())
            .sort(([a], [b]) => a - b)
            .map(([, tc]) => ({
              id: tc.id || `call_${Date.now()}`,
              type: "function" as const,
              function: { name: tc.name, arguments: tc.arguments },
            }));

          const message: Message = {
            role: "assistant",
            content: fullContent || null,
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
      yield { type: "error", error: err instanceof Error ? err.message : String(err) };
    }
  }

  async estimateTokens(messages: Message[]): Promise<number> {
    const text = messages.map((m) => m.content ?? "").join(" ");
    return Math.ceil(text.length / 4);
  }
}

function toOpenAIMessage(msg: Message): OpenAI.ChatCompletionMessageParam {
  switch (msg.role) {
    case "system":
      return { role: "system", content: msg.content ?? "" };
    case "user":
      return { role: "user", content: msg.content ?? "" };
    case "assistant":
      return {
        role: "assistant",
        content: msg.content,
        ...(msg.tool_calls?.length
          ? {
              tool_calls: msg.tool_calls.map((tc) => ({
                id: tc.id,
                type: "function" as const,
                function: { name: tc.function.name, arguments: tc.function.arguments },
              })),
            }
          : {}),
      };
    case "tool":
      return {
        role: "tool",
        content: msg.content ?? "",
        tool_call_id: msg.tool_call_id ?? "",
        ...(msg.name ? { name: msg.name } : {}),
      };
  }
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
