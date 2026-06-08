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
