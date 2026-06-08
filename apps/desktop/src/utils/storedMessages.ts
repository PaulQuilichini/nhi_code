import type { ToolCall } from "@nhicode/shared";
import type { StoredMessageDto } from "../api";
import type { ChatMessage } from "../chatTypes";
import { parseSubAgentArgs } from "./subagentStream";

export function storedMessagesToChat(messages: StoredMessageDto[]): ChatMessage[] {
  const chat: ChatMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      chat.push({
        id: `hist-u-${msg.createdAt}`,
        role: "user",
        content: msg.content ?? "",
      });
      continue;
    }

    if (msg.role === "assistant") {
      if (msg.toolCalls) {
        const calls = JSON.parse(msg.toolCalls) as ToolCall[];
        for (const call of calls) {
          if (call.function.name === "spawn_subagent") {
            const { profile, task } = parseSubAgentArgs(call.function.arguments);
            chat.push({
              id: `hist-sa-${call.id}`,
              role: "subagent",
              toolCallId: call.id,
              profile,
              task,
              status: "running",
              items: [],
            });
          } else {
            chat.push({
              id: `hist-t-${call.id}`,
              role: "tool",
              toolCallId: call.id,
              toolName: call.function.name,
              args: call.function.arguments,
              status: "running",
            });
          }
        }
      }
      if (msg.content) {
        chat.push({
          id: `hist-a-${msg.createdAt}`,
          role: "assistant",
          content: msg.content,
        });
      }
      continue;
    }

    if (msg.role === "tool") {
      const toolCallId = msg.toolCallId ?? msg.name ?? "";
      const subIdx = chat.findIndex(
        (m) => m.role === "subagent" && m.toolCallId === toolCallId && m.status === "running",
      );
      if (subIdx >= 0) {
        const sa = chat[subIdx];
        if (sa.role === "subagent") {
          chat[subIdx] = {
            ...sa,
            result: msg.content ?? undefined,
            status: "done",
          };
        }
        continue;
      }

      const idx = chat.findIndex(
        (m) => m.role === "tool" && m.toolCallId === toolCallId && m.status === "running",
      );
      if (idx >= 0) {
        const tool = chat[idx];
        if (tool.role === "tool") {
          chat[idx] = {
            ...tool,
            result: msg.content ?? undefined,
            status: "done",
          };
        }
      }
    }
  }

  return chat;
}
