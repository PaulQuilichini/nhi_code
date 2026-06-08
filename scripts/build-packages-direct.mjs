import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const tsc = join(root, "node_modules", ".pnpm", "typescript@5.9.3", "node_modules", "typescript", "bin", "tsc");
const packages = ["shared", "context", "policy", "tools", "mcp", "models", "core"];

if (!existsSync(tsc)) {
  console.error("TypeScript compiler not found. Run pnpm install first.");
  process.exit(1);
}

for (const name of packages) {
  const tsconfig = join(root, "packages", name, "tsconfig.json");
  console.log(`packages/${name} build`);
  const result = spawnSync(process.execPath, [tsc, "-p", tsconfig], {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
