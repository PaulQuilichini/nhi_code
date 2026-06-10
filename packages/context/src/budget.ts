import type {
  ContextDiagnostics,
  ContextSlotDiagnostics,
  ContextSlotName,
  ContextBudgetTier,
  Message,
  ObservationRecord,
} from "@nhicode/shared";
import { compactOlderReasoning, sanitizeMessageHistory } from "./history.js";

const TOKEN_OVERHEAD_PER_MESSAGE = 8;
const TOKEN_OVERHEAD_PER_TOOL_CALL = 12;
const TOKEN_OVERHEAD_PER_SECTION = 16;
const MIN_INPUT_BUDGET = 8_000;
const DEFAULT_INPUT_BUDGET = 128_000;
const DEFAULT_CONTEXT_TIER: ContextBudgetTier = "compact";

export interface ContextBudget {
  maxContextTokens: number;
  maxOutputTokens: number;
  tier?: ContextBudgetTier;
  providerId?: string;
  model?: string;
  inputTokens?: number;
  outputReserveTokens?: number;
  toolReserveTokens?: number;
  recentTokens?: number;
  workingMemoryTokens?: number;
  observationTokens?: number;
  dynamicTokens?: number;
  safetyFactor?: number;
}

export interface BuildBudgetedMessagesOptions {
  systemPrompt: string;
  history: Message[];
  userMessage?: string | null;
  workingMemory?: string | null;
  dynamicContext?: string | null;
  observations?: ObservationRecord[];
  threadId?: string;
  model?: string;
  providerId?: string;
  budget?: ContextBudget;
}

export function buildBudgetedMessages(options: BuildBudgetedMessagesOptions): Message[] {
  return buildBudgetedContext(options).messages;
}

export interface BuildBudgetedContextResult {
  messages: Message[];
  diagnostics: ContextDiagnostics;
}

export function buildBudgetedContext(options: BuildBudgetedMessagesOptions): BuildBudgetedContextResult {
  const budget = resolveInputBudget(options.budget);
  const slots: ContextSlotDiagnostics[] = [];

  const stablePrefix = [{ role: "system" as const, content: options.systemPrompt }];
  const stableTokens = estimateMessagesTokens(stablePrefix);
  slots.push(slot("stable_prefix", stableTokens, undefined, stablePrefix.length));

  const workingMemory = textSlotMessage(
    "working_memory",
    "## Working Memory",
    options.workingMemory,
    budget.workingMemoryTokens,
    slots,
  );

  const historyBlocks = blockMessageHistory(compactOlderReasoning(options.history));
  const selectedHistory = selectRecentBlocks(
    historyBlocks,
    Math.max(0, budget.recentTokens),
    budget.recentTokens,
  );
  const historyMessageCount = historyBlocks.reduce(
    (sum, block) => sum + block.messages.length,
    0,
  );
  slots.push(
    slot(
      "recent_history",
      estimateMessagesTokens(selectedHistory),
      budget.recentTokens,
      selectedHistory.length,
      selectedHistory.length < historyMessageCount,
    ),
  );

  const observationSlot = observationMessages(
    options.observations ?? [],
    budget.observationTokens,
    slots,
  );

  const dynamic = textSlotMessage(
    "dynamic_state",
    "## Current Workspace State",
    options.dynamicContext,
    budget.dynamicTokens,
    slots,
  );

  const userRequest =
    typeof options.userMessage === "string" && options.userMessage.trim()
      ? [{ role: "user" as const, content: options.userMessage }]
      : [];
  slots.push(
    slot(
      "user_request",
      userRequest.length ? estimateMessagesTokens(userRequest) : 0,
      undefined,
      userRequest.length,
    ),
  );

  const messages = [
    ...stablePrefix,
    ...workingMemory,
    ...selectedHistory,
    ...observationSlot.messages,
    ...dynamic,
    ...userRequest,
  ];

  const estimatedInputTokens = estimateMessagesTokens(messages);
  const diagnostics: ContextDiagnostics = {
    threadId: options.threadId,
    model: options.model,
    providerId: options.providerId,
    contextBudgetTier: budget.tier,
    createdAt: new Date().toISOString(),
    estimatedInputTokens,
    inputBudgetTokens: budget.inputTokens,
    maxContextTokens: budget.maxContextTokens,
    outputReserveTokens: budget.outputReserveTokens,
    toolReserveTokens: budget.toolReserveTokens,
    tokenSafetyFactor: budget.safetyFactor,
    suppressedObservationTokens: observationSlot.suppressedTokens,
    slots,
  };

  return { messages, diagnostics };
}

export function resolveInputBudget(budget?: ContextBudget): Required<ContextBudget> {
  const maxContextTokens = positiveInt(budget?.maxContextTokens) ?? 128_000;
  const maxOutputTokens = positiveInt(budget?.maxOutputTokens) ?? 16_000;
  const tier = budget?.tier ?? DEFAULT_CONTEXT_TIER;
  const safetyFactor = Math.min(
    1,
    Math.max(0.25, budget?.safetyFactor ?? providerSafetyFactor(budget?.providerId, budget?.model)),
  );
  const outputReserveTokens =
    Math.min(positiveInt(budget?.outputReserveTokens) ?? Math.min(maxOutputTokens, 32_000), maxOutputTokens);
  const toolReserveTokens = positiveInt(budget?.toolReserveTokens) ?? 16_000;
  const hardInputCeiling = Math.max(
    MIN_INPUT_BUDGET,
    Math.floor((maxContextTokens - outputReserveTokens - toolReserveTokens) * safetyFactor),
  );
  const configuredInput = positiveInt(budget?.inputTokens);
  const inputTokens = Math.min(configuredInput ?? defaultTierInput(tier, hardInputCeiling), hardInputCeiling);
  const tierDefaults = defaultSlotBudget(tier, inputTokens);
  const recentTokens = Math.min(
    positiveInt(budget?.recentTokens) ?? tierDefaults.recentTokens,
    inputTokens,
  );
  const workingMemoryTokens = Math.min(
    positiveInt(budget?.workingMemoryTokens) ?? tierDefaults.workingMemoryTokens,
    inputTokens,
  );
  const observationTokens = Math.min(
    positiveInt(budget?.observationTokens) ?? tierDefaults.observationTokens,
    inputTokens,
  );
  const dynamicTokens = Math.min(
    positiveInt(budget?.dynamicTokens) ?? tierDefaults.dynamicTokens,
    inputTokens,
  );

  return {
    maxContextTokens,
    maxOutputTokens,
    tier,
    providerId: budget?.providerId ?? "",
    model: budget?.model ?? "",
    inputTokens,
    outputReserveTokens,
    toolReserveTokens,
    recentTokens,
    workingMemoryTokens,
    observationTokens,
    dynamicTokens,
    safetyFactor,
  };
}

export function estimateMessagesTokens(messages: Message[]): number {
  return messages.reduce((total, msg) => total + estimateMessageTokens(msg), 0);
}

export function estimateMessageTokens(message: Message): number {
  let chars = message.content?.length ?? 0;
  chars += message.reasoning_content?.length ?? 0;
  chars += message.name?.length ?? 0;
  chars += message.tool_call_id?.length ?? 0;
  for (const call of message.tool_calls ?? []) {
    chars += call.id.length;
    chars += call.function.name.length;
    chars += call.function.arguments.length;
    chars += TOKEN_OVERHEAD_PER_TOOL_CALL * 4;
  }
  return Math.ceil(chars / 4) + TOKEN_OVERHEAD_PER_MESSAGE;
}

interface MessageBlock {
  messages: Message[];
  tokens: number;
}

function textSlotMessage(
  name: ContextSlotName,
  title: string,
  value: string | null | undefined,
  budgetTokens: number,
  slots: ContextSlotDiagnostics[],
): Message[] {
  const content = value?.trim();
  if (!content) {
    slots.push(slot(name, 0, budgetTokens, 0));
    return [];
  }
  const truncated = truncateToTokens(content, budgetTokens);
  const messages = [{ role: "system" as const, content: `${title}\n\n${truncated.text}` }];
  slots.push(slot(name, estimateMessagesTokens(messages), budgetTokens, 1, truncated.truncated));
  return messages;
}

function observationMessages(
  observations: ObservationRecord[],
  budgetTokens: number,
  slots: ContextSlotDiagnostics[],
): { messages: Message[]; suppressedTokens: number } {
  if (observations.length === 0) {
    slots.push(slot("observations", 0, budgetTokens, 0));
    return { messages: [], suppressedTokens: 0 };
  }

  const recent = [...observations].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
  const selected: string[] = [];
  let used = 0;
  let rawTokens = 0;

  for (const obs of recent) {
    rawTokens += obs.rawTokenEstimate;
    const lines = [
      `### ${obs.id} · ${obs.toolName}${obs.isError ? " · error" : ""}`,
      obs.compactContent.trim() || obs.summary,
    ];
    if (observationOffersExpansion(obs)) {
      lines.push(
        `Raw observation tokens: ~${obs.rawTokenEstimate}. Use expand_observation if exact output is needed.`,
      );
    }
    const item = lines.join("\n");
    const tokens = Math.ceil(item.length / 4) + TOKEN_OVERHEAD_PER_SECTION;
    if (used + tokens > budgetTokens) continue;
    selected.push(item);
    used += tokens;
  }

  const messages = selected.length
    ? [{ role: "system" as const, content: `## Tool Observations\n\n${selected.join("\n\n")}` }]
    : [];
  const sentTokens = estimateMessagesTokens(messages);
  slots.push(
    slot(
      "observations",
      sentTokens,
      budgetTokens,
      messages.length,
      observations.length > selected.length,
    ),
  );
  return { messages, suppressedTokens: Math.max(0, rawTokens - sentTokens) };
}

/** Only advertise expand_observation when the raw output is meaningfully larger than the compact form. */
export function observationOffersExpansion(observation: ObservationRecord): boolean {
  return observation.rawTokenEstimate >= Math.max(1, observation.tokenEstimate) * 1.5;
}

function truncateToTokens(value: string, maxTokens: number): { text: string; truncated: boolean } {
  const maxChars = Math.max(0, maxTokens * 4);
  if (value.length <= maxChars) return { text: value, truncated: false };
  return {
    text: value.slice(0, Math.max(0, maxChars - 80)).trimEnd() + "\n\n[slot truncated]",
    truncated: true,
  };
}

function slot(
  name: ContextSlotName,
  tokens: number,
  budgetTokens: number | undefined,
  messageCount: number,
  truncated = false,
): ContextSlotDiagnostics {
  return { name, tokens, budgetTokens, messageCount, truncated };
}

function blockMessageHistory(messages: Message[]): MessageBlock[] {
  const sanitized = sanitizeMessageHistory(messages);
  const blocks: MessageBlock[] = [];
  let i = 0;

  while (i < sanitized.length) {
    const msg = sanitized[i];
    const block = [msg];
    i++;

    if (msg.role === "assistant" && msg.tool_calls?.length) {
      const expectedIds = new Set(msg.tool_calls.map((call) => call.id));
      while (i < sanitized.length) {
        const next = sanitized[i];
        if (
          next.role !== "tool" ||
          !next.tool_call_id ||
          !expectedIds.has(next.tool_call_id)
        ) {
          break;
        }
        block.push(next);
        i++;
      }
    }

    blocks.push({
      messages: block,
      tokens: estimateMessagesTokens(block) + TOKEN_OVERHEAD_PER_SECTION,
    });
  }

  return blocks;
}

function selectRecentBlocks(
  blocks: MessageBlock[],
  availableHistoryTokens: number,
  recentTokenFloor: number,
): Message[] {
  if (availableHistoryTokens <= 0) return [];

  const target = Math.max(Math.min(recentTokenFloor, availableHistoryTokens), 0);
  const selected: MessageBlock[] = [];
  let used = 0;

  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (used + block.tokens > availableHistoryTokens) {
      if (used >= target) break;
      continue;
    }
    selected.unshift(block);
    used += block.tokens;
  }

  return selected.flatMap((block) => block.messages);
}

function positiveInt(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

function defaultTierInput(
  tier: ContextBudgetTier,
  hardInputCeiling: number,
): number {
  if (tier === "full") {
    return hardInputCeiling;
  }

  if (tier === "long") {
    return Math.min(
      hardInputCeiling,
      hardInputCeiling >= 500_000 ? 512_000 : Math.floor(hardInputCeiling * 0.95),
    );
  }

  return Math.min(DEFAULT_INPUT_BUDGET, hardInputCeiling);
}

function defaultSlotBudget(
  tier: ContextBudgetTier,
  inputTokens: number,
): Required<Pick<
  ContextBudget,
  "recentTokens" | "workingMemoryTokens" | "observationTokens" | "dynamicTokens"
>> {
  if (tier === "full") {
    return {
      recentTokens: Math.floor(inputTokens * 0.62),
      workingMemoryTokens: Math.min(24_000, Math.floor(inputTokens * 0.04)),
      observationTokens: Math.floor(inputTokens * 0.15),
      dynamicTokens: Math.min(8_000, Math.floor(inputTokens * 0.02)),
    };
  }

  if (tier === "long") {
    return {
      recentTokens: Math.floor(inputTokens * 0.6),
      workingMemoryTokens: Math.min(12_000, Math.floor(inputTokens * 0.06)),
      observationTokens: Math.floor(inputTokens * 0.15),
      dynamicTokens: Math.min(4_000, Math.floor(inputTokens * 0.03)),
    };
  }

  return {
    recentTokens: Math.min(64_000, inputTokens),
    workingMemoryTokens: Math.min(6_000, inputTokens),
    observationTokens: Math.min(24_000, inputTokens),
    dynamicTokens: Math.min(2_000, inputTokens),
  };
}

function providerSafetyFactor(providerId?: string, model?: string): number {
  const key = `${providerId ?? ""} ${model ?? ""}`.toLowerCase();
  if (key.includes("kimi")) return 0.8;
  return 1;
}
