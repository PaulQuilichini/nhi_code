import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { SessionManager } from "@nhicode/core";
import type { ApprovalResponse, SessionEvent } from "@nhicode/shared";

const PORT = 3847;

function getProjectRoot(): string {
  if (process.env.NHICODE_ROOT) return process.env.NHICODE_ROOT;
  const serverDir =
    typeof __dirname !== "undefined"
      ? __dirname
      : dirname(fileURLToPath(import.meta.url));
  return join(serverDir, "../../..");
}

async function main(): Promise<void> {
  const projectRoot = getProjectRoot();

  const app = express();
  app.use(cors());
  app.use(express.json());

  const manager = new SessionManager();
  await manager.initialize(projectRoot);

  const clients = new Map<string, Set<WebSocket>>();

  function broadcast(sessionId: string, event: SessionEvent): void {
    const sockets = clients.get(sessionId);
    if (!sockets) return;
    const data = JSON.stringify(event);
    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    }
  }

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", providers: manager.getProviders() });
  });

  app.get("/api/config", (_req, res) => {
    res.json(manager.getConfig());
  });

  app.post("/api/config/keys", (req, res) => {
    const { providerId, apiKey } = req.body as { providerId: string; apiKey: string };
    manager.setApiKey(providerId, apiKey);
    manager.initialize(projectRoot).then(() => res.json({ ok: true, providers: manager.getProviders() }));
  });

  app.get("/api/threads", (_req, res) => {
    res.json(manager.listThreads());
  });

  app.post("/api/threads", (req, res) => {
    try {
      const { cwd, mode, model, providerId } = req.body as {
        cwd: string;
        mode?: string;
        model?: string;
        providerId?: string;
      };
      const session = manager.createThread({ cwd, mode, model, providerId });
      res.json({
        id: session.id,
        cwd: session.cwd,
        mode: session.getMode(),
        model: session.getModel(),
        status: session.getStatus(),
      });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/threads/:id/message", async (req, res) => {
    const session = manager.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: "Thread not found" });

    const { message } = req.body as { message: string };
    const unsubscribe = session.on((event) => broadcast(req.params.id, event));

    try {
      const result = await session.send(message);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      unsubscribe();
    }
  });

  app.post("/api/threads/:id/mode", (req, res) => {
    const session = manager.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: "Thread not found" });
    const { mode } = req.body as { mode: string };
    session.setMode(mode);
    res.json({ mode: session.getMode() });
  });

  app.post("/api/threads/:id/cancel", (req, res) => {
    const session = manager.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: "Thread not found" });
    session.cancel();
    res.json({ ok: true });
  });

  app.post("/api/threads/:id/approve", (req, res) => {
    const response = req.body as ApprovalResponse;
    manager.respondToApproval(req.params.id, response);
    res.json({ ok: true });
  });

  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url ?? "", `http://127.0.0.1:${PORT}`);
    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId) {
      ws.close();
      return;
    }

    if (!clients.has(sessionId)) clients.set(sessionId, new Set());
    clients.get(sessionId)!.add(ws);

    const unsubscribe = manager.subscribe(sessionId, (event) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(event));
      }
    });

    ws.on("close", () => {
      clients.get(sessionId)?.delete(ws);
      unsubscribe();
    });
  });

  server.listen(PORT, "127.0.0.1", () => {
    console.log(`NHI Code API on http://127.0.0.1:${PORT}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
