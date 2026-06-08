import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

export class ApiKeyStore {
  private path: string;
  private keys: Record<string, string>;

  constructor(dataDir: string) {
    this.path = join(dataDir, "keys.json");
    mkdirSync(dataDir, { recursive: true });
    this.keys = this.read();
  }

  private read(): Record<string, string> {
    try {
      if (existsSync(this.path)) {
        return JSON.parse(readFileSync(this.path, "utf-8")) as Record<string, string>;
      }
    } catch {
      // corrupt file — reset
    }
    return {};
  }

  getAll(): Record<string, string> {
    return { ...this.keys };
  }

  set(providerId: string, apiKey: string): void {
    this.keys[providerId] = apiKey;
    writeFileSync(this.path, JSON.stringify(this.keys, null, 2), "utf-8");
  }
}
