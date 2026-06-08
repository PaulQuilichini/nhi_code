import type { SessionEvent } from "@nhicode/shared";
import type { ChatMessage, SubAgentMessage, ThinkingMessage } from "../chatTypes";
import { applyStreamDelta, emptyStreamBuffers } from "./streamDelta";

type NestedItem = ChatMessage;

const nestedBuffers = new Map<string, { text: string; thinking: string }>();

function getBuffer(toolCallId: string) {
  if (!nestedBuffers.has(toolCallId)) {
    nestedBuffers.set(toolCallId, { text: "", thinking: "" });
  }
  return nestedBuffers.get(toolCallId)!;
}

export function clearSubAgentBuffers(toolCallId: string) {
  nestedBuffers.delete(toolCallId);
}

/** Apply a forwarded sub-agent stream event to nested chat items (Codex-style live view). */
export function applySubAgentEvent(
  items: NestedItem[],
  toolCallId: string,
  event: SessionEvent,
): NestedItem[] {
  const buf = getBuffer(toolCallId);

  switch (event.type) {
    case "text_delta":
      buf.text = applyStreamDelta(buf.text, event.content);
      {
        const last = items[items.length - 1];
        if (last?.role === "assistant" && last.isStreaming) {
          return [
            ...items.slice(0, -1),
            { ...last, content: buf.text },
          ];
        }
        return [
          ...items,
          {
            id: `sa-text-${toolCallId}-${items.length}`,
            role: "assistant",
            content: buf.text,
            isStreaming: true,
          },
        ];
      }

    case "thinking_delta":
      buf.thinking = applyStreamDelta(buf.thinking, event.content);
      {
        const idx = items.findIndex((m) => m.role === "thinking" && m.isStreaming);
        if (idx >= 0) {
          const updated = [...items];
          updated[idx] = {
            ...updated[idx],
            content: buf.thinking,
          } as ThinkingMessage;
          return updated;
        }
        return [
          ...items,
          {
            id: `sa-think-${toolCallId}-${items.length}`,
            role: "thinking",
            content: buf.thinking,
            isStreaming: true,
          },
        ];
      }

    case "tool_call":
      Object.assign(buf, emptyStreamBuffers());
      if (items.some((m) => m.role === "tool" && m.toolCallId === event.call.id)) {
        return items.map((m) =>
          m.role === "assistant" || m.role === "thinking"
            ? m.isStreaming
              ? { ...m, isStreaming: false }
              : m
            : m,
        );
      }
      return [
        ...items.map((m) =>
          m.role === "assistant" || m.role === "thinking"
            ? m.isStreaming
              ? { ...m, isStreaming: false }
              : m
            : m,
        ),
        {
          id: `sa-tool-${event.call.id}`,
          role: "tool",
          toolCallId: event.call.id,
          toolName: event.call.function.name,
          args: event.call.function.arguments,
          status: "running",
        },
      ];

    case "tool_result":
      return items.map((m) => {
        if (m.role !== "tool") return m;
        if (m.toolCallId !== event.result.toolCallId) return m;
        return {
          ...m,
          result: event.result.content,
          status: event.result.isError ? "error" : "done",
          isError: event.result.isError,
        };
      });

    case "turn_complete":
      return items.map((m) =>
        m.role === "assistant" || m.role === "thinking"
          ? m.isStreaming
            ? { ...m, isStreaming: false }
            : m
          : m,
      );

    default:
      return items;
  }
}

export function finalizeSubAgentItems(items: NestedItem[]): NestedItem[] {
  return items.map((m) =>
    m.role === "assistant" || m.role === "thinking"
      ? m.isStreaming
        ? { ...m, isStreaming: false }
        : m
      : m,
  );
}

export function parseSubAgentArgs(argsJson: string): { profile: string; task: string } {
  try {
    const args = JSON.parse(argsJson) as { profile?: string; task?: string };
    return {
      profile: args.profile ?? "explorer",
      task: args.task ?? "",
    };
  } catch {
    return { profile: "explorer", task: "" };
  }
}

export const SUBAGENT_PROFILE_LABEL: Record<string, string> = {
  explorer: "Explorer",
  implementer: "Implementer",
  reviewer: "Reviewer",
};

export function isSubAgentMessage(m: ChatMessage): m is SubAgentMessage {
  return m.role === "subagent";
}
