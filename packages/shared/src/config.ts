import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import {
  NhiCodeConfigSchema,
  type NhiCodeConfig,
  type ProviderConfig,
} from "./types.js";

export * from "./types.js";

const DEFAULT_CONFIG: NhiCodeConfig = {
  default: {
    model: "deepseek-v4-pro",
    mode: "agent",
    provider: "deepseek",
  },
  providers: [
    {
      id: "deepseek",
      type: "openai-compatible",
      base_url: "https://api.deepseek.com",
      api_key_env: "DEEPSEEK_API_KEY",
      default_model: "deepseek-v4-pro",
      generation_config: {
        thinking: { type: "enabled" },
        reasoning_effort: "high",
      },
    },
    {
      id: "kimi",
      type: "openai-compatible",
      base_url: "https://api.moonshot.ai/v1",
      api_key_env: "MOONSHOT_API_KEY",
      default_model: "kimi-k2.5",
    },
    {
      id: "qwen",
      type: "openai-compatible",
      base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      api_key_env: "DASHSCOPE_API_KEY",
      default_model: "qwen3-coder-plus",
      generation_config: {
        enable_thinking: true,
      },
    },
  ],
  policy: {
    default_profile: "workspace-write",
    default_approval: "on-request",
  },
  agents: {
    max_threads: 6,
    max_depth: 1,
    job_max_runtime_seconds: 600,
  },
  windows: {
    sandbox: "unelevated",
  },
  darwin: {
    sandbox: "seatbelt",
  },
};

/** Prior product names — loaded silently so existing installs keep working. */
const LEGACY_CONFIG_PATHS = (cwd?: string): string[] => {
  const home = homedir();
  const paths = [
    join(home, ".suprmodl", "suprmodl.toml"),
    join(home, ".supermodel", "supermodel.toml"),
  ];
  if (cwd) {
    paths.push(join(cwd, ".suprmodl", "config.toml"));
    paths.push(join(cwd, ".supermodel", "config.toml"));
    paths.push(join(cwd, "suprmodl.toml"));
    paths.push(join(cwd, "supermodel.toml"));
  }
  return paths;
};

export function getConfigPaths(cwd?: string): string[] {
  const paths = [join(homedir(), ".nhicode", "nhicode.toml")];
  if (cwd) {
    paths.unshift(join(cwd, ".nhicode", "config.toml"));
    paths.unshift(join(cwd, "nhicode.toml"));
  }
  return [...paths, ...LEGACY_CONFIG_PATHS(cwd)];
}

export async function loadConfig(cwd?: string): Promise<NhiCodeConfig> {
  const paths = getConfigPaths(cwd);
  let merged: NhiCodeConfig = structuredClone(DEFAULT_CONFIG);

  for (const path of [...paths].reverse()) {
    try {
      await access(path);
      const raw = await readFile(path, "utf-8");
      const parsed = parseToml(raw) as Record<string, unknown>;
      merged = deepMerge(merged, NhiCodeConfigSchema.parse(normalizeTomlKeys(parsed)));
    } catch {
      // file doesn't exist or invalid — skip
    }
  }

  return NhiCodeConfigSchema.parse(merged);
}

export async function saveUserConfig(config: Partial<NhiCodeConfig>): Promise<string> {
  const path = join(homedir(), ".nhicode", "nhicode.toml");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, stringifyToml(denormalizeTomlKeys(config)), "utf-8");
  return path;
}

function normalizeTomlKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const camelKey = key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
    if (Array.isArray(value)) {
      result[camelKey] = value.map((item) =>
        typeof item === "object" && item !== null
          ? normalizeTomlKeys(item as Record<string, unknown>)
          : item,
      );
    } else if (typeof value === "object" && value !== null) {
      result[camelKey] = normalizeTomlKeys(value as Record<string, unknown>);
    } else {
      result[camelKey] = value;
    }
  }
  return result;
}

function denormalizeTomlKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const snakeKey = key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
    if (Array.isArray(value)) {
      result[snakeKey] = value.map((item) =>
        typeof item === "object" && item !== null
          ? denormalizeTomlKeys(item as Record<string, unknown>)
          : item,
      );
    } else if (typeof value === "object" && value !== null) {
      result[snakeKey] = denormalizeTomlKeys(value as Record<string, unknown>);
    } else {
      result[snakeKey] = value;
    }
  }
  return result;
}

function deepMerge<T extends Record<string, unknown>>(base: T, override: Partial<T>): T {
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      result[key] &&
      typeof result[key] === "object" &&
      !Array.isArray(result[key])
    ) {
      (result as Record<string, unknown>)[key] = deepMerge(
        result[key] as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else if (value !== undefined) {
      (result as Record<string, unknown>)[key] = value;
    }
  }
  return result;
}

export function resolveApiKey(
  provider: ProviderConfig,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  if ("api_key" in provider && provider.api_key) return provider.api_key;
  if (provider.api_key_env) return env[provider.api_key_env];
  return undefined;
}

export { DEFAULT_CONFIG };
