import type { ApprovalResponse, SessionEvent, ThreadSummary } from "@nhicode/shared";

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

export async function fetchThreads(): Promise<ThreadSummary[]> {
  const res = await fetch(`${API}/threads`);
  return res.json();
}

export async function createThread(opts: {
  cwd: string;
  mode?: string;
  model?: string;
  providerId?: string;
}): Promise<{ id: string; cwd: string; mode: string; model: string; status: string }> {
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
): Promise<{ text: string; status: string; error?: string }> {
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

export function connectWebSocket(
  sessionId: string,
  onEvent: (event: SessionEvent) => void,
): WebSocket {
  const wsUrl = isTauriApp()
    ? `ws://127.0.0.1:3847/ws?sessionId=${sessionId}`
    : `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/ws?sessionId=${sessionId}`;

  const ws = new WebSocket(wsUrl);
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
  default?: { model?: string; mode?: string; provider?: string };
  providers: Array<{
    id: string;
    base_url: string;
    default_model: string;
    api_key_env?: string;
  }>;
}

export async function fetchConfig(): Promise<Config> {
  const res = await fetch(`${API}/config`);
  return res.json();
}

export { isTauriApp };
