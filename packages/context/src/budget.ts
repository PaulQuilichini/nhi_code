import type {
  ContextDiagnostics,
  ContextSlotDiagnostics,
  ContextSlotName,
  Message,
  ObservationRecord,
} from "@nhicode/shared";
import { sanitizeMessageHistory } from "./history.js";

const TOKEN_OVERHEAD_PER_MESSAGE = 8;
const TOKEN_OVERHEAD_PER_TOOL_CALL = 12;
const TOKEN_OVERHEAD_PER_SECTION = 16;
const MIN_INPUT_BUDGET = 8_000;
const DEFAULT_INPUT_BUDGET = 128_000;

export interface ContextBudget {
  maxContextTokens: number;
  maxOutputTokens: number;
  inputTokens?: number;
  outputReserveTokens?: number;
  toolReserveTokens?: number;
  recentTokens?: number;
  workingMemoryTokens?: number;
  observationTokens?: number;
  dynamicTokens?: number;
  fileEvidenceTokens?: number;
}

export interface BuildBudgetedMessagesOptions {
  systemPrompt: string;
  history: Message[];
  userMessage: string;
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

  const historyBlocks = blockMessageHistory(options.history);
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

  const userRequest = [{ role: "user" as const, content: options.userMessage }];
  slots.push(slot("user_request", estimateMessagesTokens(userRequest), undefined, 1));

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
    createdAt: new Date().toISOString(),
    estimatedInputTokens,
    inputBudgetTokens: budget.inputTokens,
    maxContextTokens: budget.maxContextTokens,
    outputReserveTokens: budget.outputReserveTokens,
    toolReserveTokens: budget.toolReserveTokens,
    suppressedObservationTokens: observationSlot.suppressedTokens,
    slots,
  };

  return { messages, diagnostics };
}

export function resolveInputBudget(budget?: ContextBudget): Required<ContextBudget> {
  const maxContextTokens = positiveInt(budget?.maxContextTokens) ?? 128_000;
  const maxOutputTokens = positiveInt(budget?.maxOutputTokens) ?? 16_000;
  const outputReserveTokens =
    positiveInt(budget?.outputReserveTokens) ?? Math.min(maxOutputTokens, 32_000);
  const toolReserveTokens = positiveInt(budget?.toolReserveTokens) ?? 16_000;
  const hardInputCeiling = Math.max(
    MIN_INPUT_BUDGET,
    maxContextTokens - outputReserveTokens - toolReserveTokens,
  );
  const configuredInput = positiveInt(budget?.inputTokens);
  const inputTokens = Math.min(configuredInput ?? DEFAULT_INPUT_BUDGET, hardInputCeiling);
  const recentTokens = Math.min(
    positiveInt(budget?.recentTokens) ?? Math.min(16_000, inputTokens),
    inputTokens,
  );
  const workingMemoryTokens = Math.min(
    positiveInt(budget?.workingMemoryTokens) ?? 6_000,
    inputTokens,
  );
  const observationTokens = Math.min(
    positiveInt(budget?.observationTokens) ?? 24_000,
    inputTokens,
  );
  const dynamicTokens = Math.min(
    positiveInt(budget?.dynamicTokens) ?? 2_000,
    inputTokens,
  );
  const fileEvidenceTokens = Math.min(
    positiveInt(budget?.fileEvidenceTokens) ?? 48_000,
    inputTokens,
  );

  return {
    maxContextTokens,
    maxOutputTokens,
    inputTokens,
    outputReserveTokens,
    toolReserveTokens,
    recentTokens,
    workingMemoryTokens,
    observationTokens,
    dynamicTokens,
    fileEvidenceTokens,
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
    const item = [
      `### ${obs.id} · ${obs.toolName}${obs.isError ? " · error" : ""}`,
      obs.compactContent.trim() || obs.summary,
      `Raw observation tokens: ~${obs.rawTokenEstimate}. Use expand_observation if exact output is needed.`,
    ].join("\n");
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
