# NHI Code

**NHI** = **Non-Human Intelligence** — a Codex-like **native desktop** AI coding agent for DeepSeek v4, Kimi Code, Qwen Coder, and other OpenAI-compatible models.

## Features

- **Native app** — Tauri window (not a browser tab)
- **Plan / Agent / Ask modes** — policy-driven agent loop
- **Permissions & approvals** — workspace sandbox with approval gates
- **Sub-agents** — explorer, implementer, reviewer profiles
- **Codex-style chat UI** — collapsible thinking, compact tool cards, diff previews, agent turn grouping

## Quick start

### Windows

Double-click **`start-nhicode.cmd`**.

### macOS

Double-click **`start-nhicode.command`**, or:

```bash
chmod +x start-nhicode.command scripts/start-nhicode.sh
./scripts/start-nhicode.sh
```

### Requirements

| Tool | Purpose |
|------|---------|
| **Node.js 20+** | Agent API server (auto-installed by launcher if missing) |
| **Rust** | Native app shell ([rustup.rs](https://rustup.rs)) |
| **MSVC Build Tools** | C++ linker for Rust on Windows |
| **pnpm** | Dependencies (auto-installed by launcher) |

First launch compiles the Rust shell (a few minutes). Later launches are fast.

### Build an installer

```bash
pnpm install
pnpm build:packages
pnpm --filter @nhicode/desktop build
```

Output: `apps/desktop/src-tauri/target/release/bundle/` (`.msi` on Windows, `.dmg` on macOS)

## How it works

```
┌─────────────────────────────┐
│  NHI Code.app / .exe        │
│  ┌───────────────────────┐  │
│  │  Tauri window (UI)    │  │
│  └──────────┬────────────┘  │
│             │ localhost     │
│  ┌──────────▼────────────┐  │
│  │  Node API + agent     │  │
│  └───────────────────────┘  │
└─────────────────────────────┘
```

## Configuration

Edit `nhicode.toml` in your project root or use in-app Settings. User config lives at `~/.nhicode/nhicode.toml`. API keys via environment variables or the Settings panel.

## Scripts

| Command | Description |
|---------|-------------|
| `pnpm dev` | Native app (dev mode) |
| `pnpm build` | Production installer |
