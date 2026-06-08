import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { SessionManager } from "@nhicode/core";
import type { ApprovalResponse } from "@nhicode/shared";

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

  const manager = new SessionManager({ defaultProjectPath: projectRoot });
  await manager.initialize(projectRoot);

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", providers: manager.getProviders() });
  });

  app.get("/api/bootstrap", (_req, res) => {
    res.json({
      status: "ok",
      providers: manager.getProviders(),
      config: manager.getConfig(),
      projects: manager.listProjects(),
      threads: manager.listThreads(),
    });
  });

  app.get("/api/config", (_req, res) => {
    res.json(manager.getConfig());
  });

  app.post("/api/config/keys", (req, res) => {
    const { providerId, apiKey } = req.body as { providerId: string; apiKey: string };
    manager.setApiKey(providerId, apiKey);
    res.json({ ok: true, providers: manager.getProviders() });
  });

  app.get("/api/projects", (_req, res) => {
    res.json(manager.listProjects());
  });

  app.post("/api/projects", (req, res) => {
    try {
      const { name, path } = req.body as { name?: string; path: string };
      if (!path) return res.status(400).json({ error: "path is required" });
      const project = manager.createProject({ name, path });
      res.json(project);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.patch("/api/projects/:id", (req, res) => {
    try {
      const { name, path } = req.body as { name?: string; path?: string };
      const project = manager.updateProject(req.params.id, { name, path });
      res.json(project);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete("/api/projects/:id", (req, res) => {
    try {
      manager.deleteProject(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/threads", (req, res) => {
    const projectId = req.query.projectId as string | undefined;
    res.json(manager.listThreads(projectId));
  });

  app.get("/api/threads/:id/messages", (req, res) => {
    const thread = manager.getThread(req.params.id);
    if (!thread) return res.status(404).json({ error: "Thread not found" });
    res.json(manager.getThreadMessages(req.params.id));
  });

  app.post("/api/threads", (req, res) => {
    try {
      const { projectId, cwd, mode, model, providerId } = req.body as {
        projectId?: string;
        cwd?: string;
        mode?: string;
        model?: string;
        providerId?: string;
      };
      const session = manager.createThread({ projectId, cwd, mode, model, providerId });
      const thread = manager.getThread(session.id);
      res.json({
        id: session.id,
        cwd: session.cwd,
        projectId: thread?.projectId,
        mode: session.getMode(),
        model: session.getModel(),
        status: session.getStatus(),
      });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/threads/:id/message", async (req, res) => {
    let session;
    try {
      session = manager.ensureSession(req.params.id);
    } catch (err) {
      return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
    if (!session) return res.status(404).json({ error: "Thread not found" });

    const { message } = req.body as { message: string };

    try {
      const result = await session.send(message);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/threads/:id/mode", (req, res) => {
    let session;
    try {
      session = manager.ensureSession(req.params.id);
    } catch (err) {
      return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
    if (!session) return res.status(404).json({ error: "Thread not found" });
    const { mode } = req.body as { mode: string };
    session.setMode(mode);
    res.json({ mode: session.getMode() });
  });

  app.post("/api/threads/:id/cancel", (req, res) => {
    const session = manager.ensureSession(req.params.id);
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

    const unsubscribe = manager.subscribe(sessionId, (event) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(event));
      }
    });

    ws.on("close", () => {
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
