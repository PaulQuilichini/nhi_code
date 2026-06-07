import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import type { ThreadSummary } from "@nhicode/shared";

interface StoredMessage {
  threadId: string;
  role: string;
  content: string | null;
  toolCalls?: string;
  toolCallId?: string;
  name?: string;
  createdAt: string;
}

interface StoreData {
  threads: ThreadSummary[];
  messages: StoredMessage[];
}

export class JsonStore {
  private path: string;
  private data: StoreData;

  constructor(dataDir: string) {
    this.path = join(dataDir, "store.json");
    mkdirSync(dataDir, { recursive: true });
    this.data = this.read();
  }

  private read(): StoreData {
    try {
      if (existsSync(this.path)) {
        return JSON.parse(readFileSync(this.path, "utf-8")) as StoreData;
      }
    } catch {
      // corrupt file — reset
    }
    return { threads: [], messages: [] };
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.data, null, 2), "utf-8");
  }

  listThreads(): ThreadSummary[] {
    return [...this.data.threads].sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
  }

  upsertThread(thread: ThreadSummary): void {
    const idx = this.data.threads.findIndex((t) => t.id === thread.id);
    if (idx >= 0) {
      this.data.threads[idx] = thread;
    } else {
      this.data.threads.unshift(thread);
    }
    this.persist();
  }

  updateThread(id: string, patch: Partial<ThreadSummary>): void {
    const idx = this.data.threads.findIndex((t) => t.id === id);
    if (idx >= 0) {
      this.data.threads[idx] = { ...this.data.threads[idx], ...patch };
      this.persist();
    }
  }

  addMessage(msg: StoredMessage): void {
    this.data.messages.push(msg);
    this.persist();
  }
}

export type { StoredMessage };
