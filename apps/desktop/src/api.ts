import type {
  AgentCarefulness,
  ApprovalResponse,
  ApprovalRule,
  ContextBudgetTier,
  ObservationRecord,
  Project,
  QueuedPrompt,
  SessionEvent,
  ThreadSummary,
  TurnResult,
} from "@nhicode/shared";

/** Native Tauri app talks to the local API server directly (not via browser proxy). */
function isTauriApp(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

const API_HOST = isTauriApp() ? "http://127.0.0.1:3847" : "";
const API = `${API_HOST}/api`;

export async function fetchHealth(): Promise<{ status: string; providers: string[] }> {
  const res = await fetch(`${API}/health`);
  return res.json();
}

export interface BootstrapResponse {
  status: string;
  providers: string[];
  config: Config;
  projects: Project[];
  threads: ThreadSummary[];
}

export async function fetchBootstrap(): Promise<BootstrapResponse> {
  const res = await fetch(`${API}/bootstrap`);
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error ?? "Failed to load app state");
  }
  return res.json();
}

export async function fetchProjects(): Promise<Project[]> {
  const res = await fetch(`${API}/projects`);
  return res.json();
}

export async function createProject(opts: {
  name?: string;
  path: string;
}): Promise<Project> {
  const res = await fetch(`${API}/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error ?? "Failed to create project");
  }
  return res.json();
}

export async function updateProject(
  id: string,
  patch: { name?: string; path?: string },
): Promise<Project> {
  const res = await fetch(`${API}/projects/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error ?? "Failed to update project");
  }
  return res.json();
}

export async function deleteProject(id: string): Promise<void> {
  const res = await fetch(`${API}/projects/${id}`, { method: "DELETE" });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error ?? "Failed to delete project");
  }
}

export async function fetchThreads(projectId?: string): Promise<ThreadSummary[]> {
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
  const res = await fetch(`${API}/threads${query}`);
  return res.json();
}

export async function fetchApprovalRules(projectId?: string): Promise<ApprovalRule[]> {
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
  const res = await fetch(`${API}/approval-rules${query}`);
  return res.json();
}

export async function deleteApprovalRule(id: string): Promise<void> {
  const res = await fetch(`${API}/approval-rules/${id}`, { method: "DELETE" });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error ?? "Failed to delete approval rule");
  }
}

export interface StoredMessageDto {
  threadId: string;
  role: string;
  content: string | null;
  reasoningContent?: string;
  toolCalls?: string;
  toolCallId?: string;
  name?: string;
  createdAt: string;
}

export interface StoredRunEventDto {
  id: string;
  threadId: string;
  createdAt: string;
  type: string;
  status?: string;
  message?: string;
  detail?: Record<string, unknown>;
}

export async function fetchThreadMessages(threadId: string): Promise<StoredMessageDto[]> {
  const res = await fetch(`${API}/threads/${threadId}/messages`);
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error ?? "Failed to load messages");
  }
  return res.json();
}

export async function fetchThreadEvents(threadId: string): Promise<StoredRunEventDto[]> {
  const res = await fetch(`${API}/threads/${threadId}/events`);
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error ?? "Failed to load events");
  }
  return res.json();
}

export async function fetchThreadObservations(threadId: string): Promise<ObservationRecord[]> {
  const res = await fetch(`${API}/threads/${threadId}/observations`);
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error ?? "Failed to load observations");
  }
  return res.json();
}

export async function fetchQueuedPrompts(threadId: string): Promise<QueuedPrompt[]> {
  const res = await fetch(`${API}/threads/${threadId}/queue`);
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error ?? "Failed to load queued prompts");
  }
  return res.json();
}

export async function createThread(opts: {
  projectId?: string;
  cwd?: string;
  mode?: string;
  model?: string;
  providerId?: string;
  modelMode?: string;
  contextBudgetTier?: ContextBudgetTier;
  agentCarefulness?: AgentCarefulness;
}): Promise<{
  id: string;
  cwd: string;
  projectId?: string;
  mode: string;
  model: string;
  modelMode?: string;
  contextBudgetTier?: ContextBudgetTier;
  agentCarefulness?: AgentCarefulness;
  providerId?: string;
  status: string;
}> {
  const res = await fetch(`${API}/threads`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error ?? "Failed to create thread");
  }
  return res.json();
}

export async function sendMessage(
  threadId: string,
  message: string,
): Promise<TurnResult> {
  const res = await fetch(`${API}/threads/${threadId}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error ?? "Failed to send message");
  }
  return res.json();
}

export async function setThreadMode(threadId: string, mode: string): Promise<void> {
  await fetch(`${API}/threads/${threadId}/mode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode }),
  });
}

export async function setThreadModelMode(threadId: string, modelMode?: string): Promise<void> {
  await fetch(`${API}/threads/${threadId}/model-mode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ modelMode }),
  });
}

export async function setThreadContextBudgetTier(
  threadId: string,
  contextBudgetTier: ContextBudgetTier,
): Promise<void> {
  await fetch(`${API}/threads/${threadId}/context-tier`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contextBudgetTier }),
  });
}

export async function cancelThread(threadId: string): Promise<void> {
  await fetch(`${API}/threads/${threadId}/cancel`, { method: "POST" });
}

export async function respondToApproval(
  threadId: string,
  response: ApprovalResponse,
): Promise<void> {
  await fetch(`${API}/threads/${threadId}/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(response),
  });
}

export async function setApiKey(providerId: string, apiKey: string): Promise<string[]> {
  const res = await fetch(`${API}/config/keys`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ providerId, apiKey }),
  });
  const data = await res.json();
  return data.providers;
}

export async function updateAgentConfig(patch: { max_turns?: number }): Promise<Config> {
  const res = await fetch(`${API}/config/agents`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error ?? "Failed to update agent settings");
  }
  return res.json();
}

export async function queuePrompt(threadId: string, text: string): Promise<QueuedPrompt> {
  const res = await fetch(`${API}/threads/${threadId}/queue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error ?? "Failed to queue prompt");
  }
  return res.json();
}

export async function deleteQueuedPrompt(threadId: string, promptId: string): Promise<void> {
  const res = await fetch(`${API}/threads/${threadId}/queue/${promptId}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error ?? "Failed to delete queued prompt");
  }
}

export async function steerThread(threadId: string, text: string): Promise<void> {
  const res = await fetch(`${API}/threads/${threadId}/steer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error ?? "Failed to steer thread");
  }
}

export function connectWebSocket(
  sessionId: string,
  onEvent: (event: SessionEvent) => void,
  callbacks?: {
    onOpen?: () => void;
    onClose?: (event: CloseEvent) => void;
    onError?: (event: Event) => void;
  },
): WebSocket {
  const wsUrl = isTauriApp()
    ? `ws://127.0.0.1:3847/ws?sessionId=${sessionId}`
    : `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/ws?sessionId=${sessionId}`;

  const ws = new WebSocket(wsUrl);
  ws.onopen = () => callbacks?.onOpen?.();
  ws.onclose = (e) => callbacks?.onClose?.(e);
  ws.onerror = (e) => callbacks?.onError?.(e);
  ws.onmessage = (msg) => {
    try {
      onEvent(JSON.parse(msg.data) as SessionEvent);
    } catch {
      // ignore malformed
    }
  };
  return ws;
}

export interface Config {
  default?: {
    model?: string;
    mode?: string;
    provider?: string;
    context_budget_tier?: ContextBudgetTier;
  };
  providers: Array<{
    id: string;
    base_url: string;
    default_model: string;
    api_key_env?: string;
  }>;
  agents?: {
    max_turns?: number;
    max_threads?: number;
    max_depth?: number;
    job_max_runtime_seconds?: number;
    model_idle_timeout_seconds?: number;
    model_request_timeout_seconds?: number;
    shell_timeout_seconds?: number;
  };
}

export async function fetchConfig(): Promise<Config> {
  const res = await fetch(`${API}/config`);
  return res.json();
}

export { isTauriApp };
