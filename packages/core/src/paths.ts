import { basename, resolve } from "node:path";

export function normalizePathKey(path: string): string {
  return resolve(path).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function projectNameFromPath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return basename(normalized) || normalized || "Project";
}
