import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { ApprovalRule, ObservationRecord, Project, ThreadSummary } from "@nhicode/shared";
import { normalizePathKey, projectNameFromPath } from "./paths.js";

interface StoredMessage {
  threadId: string;
  role: string;
  content: string | null;
  reasoningContent?: string;
  toolCalls?: string;
  toolCallId?: string;
  name?: string;
  createdAt: string;
}

interface StoreData {
  projects: Project[];
  threads: ThreadSummary[];
  messages: StoredMessage[];
  threadMemories: StoredThreadMemory[];
  runEvents: StoredRunEvent[];
  approvalRules: ApprovalRule[];
  observations: ObservationRecord[];
}

interface StoredThreadMemory {
  threadId: string;
  content: string;
  updatedAt: string;
}

interface StoredRunEvent {
  id: string;
  threadId: string;
  createdAt: string;
  type: string;
  status?: string;
  message?: string;
  detail?: Record<string, unknown>;
}

export class JsonStore {
  private path: string;
  private data: StoreData;
  private maxRunEvents = 5_000;

  constructor(dataDir: string, defaultProjectPath?: string) {
    this.path = join(dataDir, "store.json");
    mkdirSync(dataDir, { recursive: true });
    this.data = this.read();
    this.migrateProjects(defaultProjectPath);
  }

  private read(): StoreData {
    try {
      if (existsSync(this.path)) {
        const raw = JSON.parse(readFileSync(this.path, "utf-8")) as Partial<StoreData>;
        return {
          projects: raw.projects ?? [],
          threads: raw.threads ?? [],
          messages: raw.messages ?? [],
          threadMemories: raw.threadMemories ?? [],
          runEvents: raw.runEvents ?? [],
          approvalRules: raw.approvalRules ?? [],
          observations: raw.observations ?? [],
        };
      }
    } catch {
      // corrupt file — reset
    }
    return {
      projects: [],
      threads: [],
      messages: [],
      threadMemories: [],
      runEvents: [],
      approvalRules: [],
      observations: [],
    };
  }

  private migrateProjects(defaultProjectPath?: string): void {
    if (this.data.projects.length > 0) {
      this.assignMissingProjectIds();
      return;
    }

    const now = new Date().toISOString();
    const cwdSet = new Map<string, string>();

    for (const thread of this.data.threads) {
      if (thread.parentId) continue;
      const key = normalizePathKey(thread.cwd);
      if (!cwdSet.has(key)) cwdSet.set(key, thread.cwd);
    }

    if (cwdSet.size === 0 && defaultProjectPath) {
      const path = defaultProjectPath;
      const project: Project = {
        id: randomUUID(),
        name: projectNameFromPath(path),
        path,
        createdAt: now,
        updatedAt: now,
      };
      this.data.projects.push(project);
      for (const thread of this.data.threads) {
        if (!thread.parentId && !thread.projectId) {
          thread.projectId = project.id;
        }
      }
      this.persist();
      return;
    }

    for (const path of cwdSet.values()) {
      const project: Project = {
        id: randomUUID(),
        name: projectNameFromPath(path),
        path,
        createdAt: now,
        updatedAt: now,
      };
      this.data.projects.push(project);
      const key = normalizePathKey(path);
      for (const thread of this.data.threads) {
        if (thread.parentId) continue;
        if (!thread.projectId && normalizePathKey(thread.cwd) === key) {
          thread.projectId = project.id;
        }
      }
    }

    if (this.data.projects.length > 0) {
      this.persist();
    }
  }

  private assignMissingProjectIds(): void {
    let changed = false;
    for (const thread of this.data.threads) {
      if (thread.parentId || thread.projectId) continue;
      let match = this.data.projects.find(
        (p) => normalizePathKey(p.path) === normalizePathKey(thread.cwd),
      );
      if (!match) {
        const now = new Date().toISOString();
        match = {
          id: randomUUID(),
          name: projectNameFromPath(thread.cwd),
          path: thread.cwd,
          createdAt: now,
          updatedAt: now,
        };
        this.data.projects.push(match);
      }
      thread.projectId = match.id;
      changed = true;
    }
    if (changed) this.persist();
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.data, null, 2), "utf-8");
  }

  listProjects(): Project[] {
    return [...this.data.projects].sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
  }

  getProject(id: string): Project | undefined {
    return this.data.projects.find((p) => p.id === id);
  }

  createProject(input: { name?: string; path: string }): Project {
    const path = resolve(input.path);
    const key = normalizePathKey(path);
    const existing = this.data.projects.find((p) => normalizePathKey(p.path) === key);
    if (existing) {
      throw new Error(`Project already exists at ${existing.path}`);
    }

    const now = new Date().toISOString();
    const project: Project = {
      id: randomUUID(),
      name: input.name?.trim() || projectNameFromPath(path),
      path,
      createdAt: now,
      updatedAt: now,
    };
    this.data.projects.unshift(project);
    this.persist();
    return project;
  }

  updateProject(id: string, patch: { name?: string; path?: string }): Project | undefined {
    const idx = this.data.projects.findIndex((p) => p.id === id);
    if (idx < 0) return undefined;

    const current = this.data.projects[idx];
    if (patch.path && normalizePathKey(patch.path) !== normalizePathKey(current.path)) {
      const resolvedPath = resolve(patch.path);
      const key = normalizePathKey(resolvedPath);
      const duplicate = this.data.projects.find(
        (p) => p.id !== id && normalizePathKey(p.path) === key,
      );
      if (duplicate) {
        throw new Error(`Project already exists at ${duplicate.path}`);
      }
      for (const thread of this.data.threads) {
        if (thread.projectId === id) {
          thread.cwd = resolvedPath;
        }
      }
    }

    const updated: Project = {
      ...current,
      ...patch,
      path: patch.path ? resolve(patch.path) : current.path,
      name: patch.name?.trim() || current.name,
      updatedAt: new Date().toISOString(),
    };
    this.data.projects[idx] = updated;
    this.persist();
    return updated;
  }

  deleteProject(id: string): boolean {
    const idx = this.data.projects.findIndex((p) => p.id === id);
    if (idx < 0) return false;

    const project = this.data.projects[idx];
    const threadIds = new Set(
      this.data.threads.filter((t) => t.projectId === id).map((t) => t.id),
    );
    this.data.threads = this.data.threads.filter((t) => t.projectId !== id);
    this.data.messages = this.data.messages.filter((m) => !threadIds.has(m.threadId));
    this.data.threadMemories = this.data.threadMemories.filter((m) => !threadIds.has(m.threadId));
    this.data.observations = this.data.observations.filter((m) => !threadIds.has(m.threadId));
    this.data.approvalRules = this.data.approvalRules.filter(
      (r) => normalizePathKey(r.projectPath) !== normalizePathKey(project.path),
    );
    this.data.projects.splice(idx, 1);
    this.persist();
    return true;
  }

  listApprovalRules(projectPath?: string): ApprovalRule[] {
    const key = projectPath ? normalizePathKey(projectPath) : undefined;
    return this.data.approvalRules
      .filter((rule) => !key || normalizePathKey(rule.projectPath) === key)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  addApprovalRule(input: Omit<ApprovalRule, "id" | "createdAt">): ApprovalRule {
    const existing = this.data.approvalRules.find((rule) => approvalRuleEquals(rule, input));
    const now = new Date().toISOString();
    if (existing) {
      existing.lastUsedAt = now;
      this.persist();
      return existing;
    }

    const rule: ApprovalRule = {
      id: randomUUID(),
      createdAt: now,
      ...input,
    };
    this.data.approvalRules.unshift(rule);
    this.persist();
    return rule;
  }

  deleteApprovalRule(id: string): boolean {
    const before = this.data.approvalRules.length;
    this.data.approvalRules = this.data.approvalRules.filter((rule) => rule.id !== id);
    if (this.data.approvalRules.length === before) return false;
    this.persist();
    return true;
  }

  listThreads(projectId?: string): ThreadSummary[] {
    let threads = this.data.threads.filter((t) => !t.parentId);
    if (projectId) {
      threads = threads.filter((t) => t.projectId === projectId);
    }
    return threads.sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
  }

  getThread(id: string): ThreadSummary | undefined {
    return this.data.threads.find((t) => t.id === id);
  }

  getThreadMessages(threadId: string): StoredMessage[] {
    return this.data.messages.filter((m) => m.threadId === threadId);
  }

  setThreadMessages(threadId: string, messages: StoredMessage[]): void {
    this.data.messages = this.data.messages.filter((m) => m.threadId !== threadId);
    this.data.messages.push(...messages);
    this.persist();
  }

  getThreadMemory(threadId: string): StoredThreadMemory | undefined {
    return this.data.threadMemories.find((m) => m.threadId === threadId);
  }

  setThreadMemory(threadId: string, content: string): void {
    const updatedAt = new Date().toISOString();
    const idx = this.data.threadMemories.findIndex((m) => m.threadId === threadId);
    const memory: StoredThreadMemory = { threadId, content, updatedAt };
    if (idx >= 0) {
      this.data.threadMemories[idx] = memory;
    } else {
      this.data.threadMemories.push(memory);
    }
    this.persist();
  }

  upsertThread(thread: ThreadSummary): void {
    const idx = this.data.threads.findIndex((t) => t.id === thread.id);
    if (idx >= 0) {
      this.data.threads[idx] = thread;
    } else {
      this.data.threads.unshift(thread);
    }
    if (thread.projectId) {
      const project = this.getProject(thread.projectId);
      if (project) {
        project.updatedAt = new Date().toISOString();
      }
    }
    this.persist();
  }

  updateThread(id: string, patch: Partial<ThreadSummary>): void {
    const idx = this.data.threads.findIndex((t) => t.id === id);
    if (idx >= 0) {
      this.data.threads[idx] = { ...this.data.threads[idx], ...patch };
      const projectId = this.data.threads[idx].projectId;
      if (projectId) {
        const project = this.getProject(projectId);
        if (project) {
          project.updatedAt = new Date().toISOString();
        }
      }
      this.persist();
    }
  }

  addMessage(msg: StoredMessage): void {
    this.data.messages.push(msg);
    this.persist();
  }

  addRunEvent(event: Omit<StoredRunEvent, "id">): void {
    this.data.runEvents.push({ id: randomUUID(), ...event });
    if (this.data.runEvents.length > this.maxRunEvents) {
      this.data.runEvents.splice(0, this.data.runEvents.length - this.maxRunEvents);
    }
    this.persist();
  }

  listRunEvents(threadId: string, limit = 200): StoredRunEvent[] {
    return this.data.runEvents.filter((e) => e.threadId === threadId).slice(-limit);
  }

  addObservation(input: Omit<ObservationRecord, "id" | "createdAt">): ObservationRecord {
    const observation: ObservationRecord = {
      id: `obs_${this.data.observations.length + 1}_${randomUUID().slice(0, 8)}`,
      createdAt: new Date().toISOString(),
      ...input,
    };
    this.data.observations.push(observation);
    this.persist();
    return observation;
  }

  listObservations(threadId: string, limit = 80): ObservationRecord[] {
    return this.data.observations
      .filter((obs) => obs.threadId === threadId)
      .slice(-limit);
  }

  getObservation(threadId: string, id: string): ObservationRecord | undefined {
    return this.data.observations.find((obs) => obs.threadId === threadId && obs.id === id);
  }
}

function approvalRuleEquals(
  rule: ApprovalRule,
  input: Omit<ApprovalRule, "id" | "createdAt">,
): boolean {
  return (
    rule.scope === input.scope &&
    normalizePathKey(rule.projectPath) === normalizePathKey(input.projectPath) &&
    rule.kind === input.kind &&
    rule.toolName === input.toolName &&
    rule.category === input.category &&
    rule.prefix === input.prefix
  );
}

export type { StoredMessage, StoredRunEvent, StoredThreadMemory };
