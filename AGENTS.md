# NHI Code — Project Instructions

NHI = **Non-Human Intelligence**. This is the NHI Code agent itself. When working on this codebase:

## Architecture

- `packages/core` — agent loop, sessions, orchestration
- `packages/models` — OpenAI-compatible provider adapters (DeepSeek, Kimi, Qwen)
- `packages/policy` — modes, approvals, sandbox rules
- `packages/tools` — built-in tools (fs, shell, git, grep)
- `packages/context` — context assembly, AGENTS.md loading
- `packages/shared` — types and config schema
- `apps/desktop` — React UI + Express API server

## Conventions

- TypeScript ESM throughout, strict mode
- Modes are policy profiles, not separate agent loops
- Every tool call passes through PolicyEngine.evaluate()
- Provider-specific quirks stay in adapter layer, never in the agent loop
- Prefer minimal diffs; match existing code style

## Commands

```bash
pnpm install
pnpm dev        # start UI + API
pnpm build      # build all packages
```
