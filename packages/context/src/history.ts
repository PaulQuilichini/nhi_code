import type { Message } from "@nhicode/shared";

/** Drop orphan tool messages and incomplete tool-call blocks. */
export function sanitizeMessageHistory(messages: Message[]): Message[] {
  const result: Message[] = [];
  let i = 0;

  while (i < messages.length) {
    const msg = messages[i];

    if (msg.role === "tool") {
      i++;
      continue;
    }

    if (msg.role === "assistant" && msg.tool_calls?.length) {
      const block: Message[] = [msg];
      const expectedIds = new Set(msg.tool_calls.map((tc) => tc.id));
      i++;

      while (i < messages.length && messages[i].role === "tool") {
        const toolMsg = messages[i];
        if (toolMsg.tool_call_id && expectedIds.has(toolMsg.tool_call_id)) {
          block.push(toolMsg);
        }
        i++;
      }

      const answered = new Set(
        block.filter((m) => m.role === "tool").map((m) => m.tool_call_id),
      );
      if (msg.tool_calls.every((tc) => answered.has(tc.id))) {
        result.push(...block);
      }
      continue;
    }

    result.push(msg);
    i++;
  }

  return result;
}

const REASONING_KEEP_RECENT_TURNS = 3;
const REASONING_SUMMARY_MAX_CHARS = 240;

/**
 * Replace reasoning_content on older assistant turns with a one-sentence summary.
 * Only the returned copies are altered; the input messages are left intact so
 * persisted history keeps full reasoning.
 */
export function compactOlderReasoning(
  messages: Message[],
  keepRecent = REASONING_KEEP_RECENT_TURNS,
): Message[] {
  const reasoningIndexes: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "assistant" && msg.reasoning_content?.trim()) {
      reasoningIndexes.push(i);
    }
  }
  if (reasoningIndexes.length <= keepRecent) return messages;

  const compactable = new Set(reasoningIndexes.slice(0, reasoningIndexes.length - keepRecent));
  return messages.map((msg, i) =>
    compactable.has(i)
      ? { ...msg, reasoning_content: summarizeReasoning(msg.reasoning_content!) }
      : msg,
  );
}

function summarizeReasoning(reasoning: string): string {
  const normalized = reasoning.replace(/\s+/g, " ").trim();
  const firstSentence = normalized.split(/(?<=[.!?])\s/, 1)[0] ?? normalized;
  const summary =
    firstSentence.length > REASONING_SUMMARY_MAX_CHARS
      ? `${firstSentence.slice(0, REASONING_SUMMARY_MAX_CHARS).trimEnd()}…`
      : firstSentence;
  return `[earlier reasoning summarized] ${summary}`;
}

/** Trim history without splitting assistant/tool-call blocks. */
export function trimMessageHistory(messages: Message[], max: number): Message[] {
  if (messages.length <= max) return sanitizeMessageHistory(messages);

  let start = messages.length - max;

  // Walk back to include the assistant that owns leading tool messages
  while (start > 0 && messages[start].role === "tool") {
    start--;
  }

  // Skip orphan tools at the front of the slice
  while (start < messages.length && messages[start].role === "tool") {
    start++;
  }

  return sanitizeMessageHistory(messages.slice(start));
}
