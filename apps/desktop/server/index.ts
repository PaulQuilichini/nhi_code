import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { basename, dirname, join } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { SessionManager } from "@nhicode/core";
import type { AgentCarefulness, ApprovalResponse, ContextBudgetTier } from "@nhicode/shared";

const PORT = 3847;

function getProjectRoot(): string {
  if (process.env.NHICODE_ROOT) return process.env.NHICODE_ROOT;
  const cwd = process.cwd();
  return basename(cwd) === "desktop" && basename(dirname(cwd)) === "apps"
    ? join(cwd, "../..")
    : cwd;
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

  app.patch("/api/config/agents", async (req, res) => {
    try {
      const { max_turns } = req.body as { max_turns?: number };
      if (max_turns !== undefined && (!Number.isFinite(max_turns) || max_turns < 0)) {
        return res.status(400).json({ error: "max_turns must be a non-negative number" });
      }
      const config = await manager.updateAgentConfig({ max_turns });
      res.json(config);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
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

  app.get("/api/approval-rules", (req, res) => {
    const projectId = req.query.projectId as string | undefined;
    res.json(manager.listApprovalRules(projectId));
  });

  app.delete("/api/approval-rules/:id", (req, res) => {
    try {
      manager.deleteApprovalRule(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
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

  app.get("/api/threads/:id/events", (req, res) => {
    const thread = manager.getThread(req.params.id);
    if (!thread) return res.status(404).json({ error: "Thread not found" });
    res.json(manager.getThreadEvents(req.params.id));
  });

  app.get("/api/threads/:id/observations", (req, res) => {
    const thread = manager.getThread(req.params.id);
    if (!thread) return res.status(404).json({ error: "Thread not found" });
    const limit = Number(req.query.limit ?? 200);
    res.json(manager.listObservations(req.params.id, Number.isFinite(limit) ? limit : 200));
  });

  app.get("/api/threads/:id/observations/:observationId", (req, res) => {
    const thread = manager.getThread(req.params.id);
    if (!thread) return res.status(404).json({ error: "Thread not found" });
    const observation = manager.getObservation(req.params.id, req.params.observationId);
    if (!observation) return res.status(404).json({ error: "Observation not found" });
    res.json(observation);
  });

  app.post("/api/threads", (req, res) => {
    try {
      const { projectId, cwd, mode, model, providerId, modelMode, contextBudgetTier, agentCarefulness } = req.body as {
        projectId?: string;
        cwd?: string;
        mode?: string;
        model?: string;
        providerId?: string;
        modelMode?: string;
        contextBudgetTier?: ContextBudgetTier;
        agentCarefulness?: AgentCarefulness;
      };
      const session = manager.createThread({
        projectId,
        cwd,
        mode,
        model,
        providerId,
        modelMode,
        contextBudgetTier,
        agentCarefulness,
      });
      const thread = manager.getThread(session.id);
      res.json({
        id: session.id,
        cwd: session.cwd,
        projectId: thread?.projectId,
        mode: session.getMode(),
        model: session.getModel(),
        modelMode: session.getModelMode(),
        contextBudgetTier: session.getContextBudgetTier(),
        agentCarefulness: session.getAgentCarefulness(),
        providerId: thread?.providerId,
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

  app.get("/api/threads/:id/queue", (req, res) => {
    const thread = manager.getThread(req.params.id);
    if (!thread) return res.status(404).json({ error: "Thread not found" });
    res.json(manager.listQueuedPrompts(req.params.id));
  });

  app.post("/api/threads/:id/queue", (req, res) => {
    try {
      const thread = manager.getThread(req.params.id);
      if (!thread) return res.status(404).json({ error: "Thread not found" });
      const { text } = req.body as { text?: string };
      if (!text?.trim()) return res.status(400).json({ error: "Prompt text is required" });
      res.json(manager.enqueuePrompt(req.params.id, text));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete("/api/threads/:id/queue/:promptId", (req, res) => {
    try {
      const thread = manager.getThread(req.params.id);
      if (!thread) return res.status(404).json({ error: "Thread not found" });
      manager.deleteQueuedPrompt(req.params.id, req.params.promptId);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/threads/:id/steer", (req, res) => {
    try {
      const { text } = req.body as { text?: string };
      if (!text?.trim()) return res.status(400).json({ error: "Steering text is required" });
      manager.steerThread(req.params.id, text);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
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

  app.post("/api/threads/:id/model-mode", (req, res) => {
    const thread = manager.getThread(req.params.id);
    if (!thread) return res.status(404).json({ error: "Thread not found" });
    const { modelMode } = req.body as { modelMode?: string };
    manager.setThreadModelMode(req.params.id, modelMode);
    res.json({ modelMode });
  });

  app.post("/api/threads/:id/context-tier", (req, res) => {
    const thread = manager.getThread(req.params.id);
    if (!thread) return res.status(404).json({ error: "Thread not found" });
    const { contextBudgetTier } = req.body as { contextBudgetTier?: ContextBudgetTier };
    if (
      contextBudgetTier !== "compact" &&
      contextBudgetTier !== "long" &&
      contextBudgetTier !== "full"
    ) {
      return res.status(400).json({ error: "Invalid context budget tier" });
    }
    manager.setThreadContextBudgetTier(req.params.id, contextBudgetTier);
    res.json({ contextBudgetTier });
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
  const handleListenError = (err: NodeJS.ErrnoException): void => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `NHI Code API port ${PORT} is already in use. Stop the existing listener and restart.`,
      );
    } else {
      console.error(err);
    }
    process.exit(1);
  };

  server.on("error", handleListenError);
  wss.on("error", handleListenError);

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
