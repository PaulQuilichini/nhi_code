export interface UserMessage {
  id: string;
  role: "user";
  content: string;
}

export interface AssistantMessage {
  id: string;
  role: "assistant";
  content: string;
  isStreaming?: boolean;
  isError?: boolean;
}

export interface ThinkingMessage {
  id: string;
  role: "thinking";
  content: string;
  isStreaming?: boolean;
}

export interface ToolMessage {
  id: string;
  role: "tool";
  toolCallId: string;
  toolName: string;
  args: string;
  result?: string;
  status: "running" | "done" | "error";
  isError?: boolean;
  observationId?: string;
  rawContentLength?: number;
  compacted?: boolean;
}

export interface SubAgentMessage {
  id: string;
  role: "subagent";
  toolCallId: string;
  profile: string;
  task: string;
  sessionId?: string;
  status: "running" | "done" | "error";
  result?: string;
  items: ChatMessage[];
}

export type ChatMessage =
  | UserMessage
  | AssistantMessage
  | ThinkingMessage
  | ToolMessage
  | SubAgentMessage;

export interface PendingApproval {
  requestId: string;
  toolName: string;
  args: string;
  scopes: string[];
  category: string;
  suggestedShellPrefix?: string;
}

export interface StatusNotice {
  kind: "error" | "warning" | "info";
  message: string;
}
