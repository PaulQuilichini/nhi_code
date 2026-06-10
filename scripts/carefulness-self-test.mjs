import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ContextBuilder,
  compactOlderReasoning,
  observationOffersExpansion,
} from "../packages/context/dist/index.js";
import { SessionManager, Session } from "../packages/core/dist/index.js";
import { PolicyEngine } from "../packages/policy/dist/index.js";
import { ToolRegistry } from "../packages/tools/dist/index.js";

function toolCall(id, name, args) {
  return {
    id,
    type: "function",
    function: {
      name,
      arguments: JSON.stringify(args),
    },
  };
}

class FakeProvider {
  constructor(steps) {
    this.steps = [...steps];
    this.calls = [];
  }

  getModelInfo(model) {
    return {
      id: model,
      name: model,
      provider: "deepseek",
      maxContext: 128_000,
      maxOutput: 16_000,
      capabilities: { toolCalling: true, thinking: true, streaming: true },
    };
  }

  async estimateTokens() {
    return 100;
  }

  async *chat(request) {
    this.calls.push({
      messages: request.messages,
      tools: request.tools,
      generationConfig: request.generationConfig,
    });
    const step = this.steps.shift() ?? { kind: "final", text: "done" };
    if (step.kind === "tool") {
      yield {
        type: "done",
        message: {
          role: "assistant",
          content: null,
          tool_calls: [step.call],
        },
      };
      return;
    }
    yield { type: "text_delta", content: step.text };
    yield {
      type: "done",
      message: { role: "assistant", content: step.text },
    };
  }
}

async function withTempProject(fn) {
  const dir = await mkdtemp(join(tmpdir(), "nhicode-carefulness-"));
  try {
    await writeFile(join(dir, "sample.txt"), "old\n", "utf-8");
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runReadLoop(cwd, maxTurns, toolTurns) {
  const provider = new FakeProvider([
    ...Array.from({ length: toolTurns }, (_, i) => ({
      kind: "tool",
      call: toolCall(`read_${i}`, "read_file", { path: "sample.txt", limit: 1 }),
    })),
    { kind: "final", text: "done" },
  ]);
  const session = new Session(
    {
      cwd,
      mode: "ask",
      model: "deepseek-v4-pro",
      providerId: "deepseek",
      agentCarefulness: "standard",
    },
    provider,
    new PolicyEngine("ask"),
    new ToolRegistry(),
    new ContextBuilder(),
    { maxTurns },
  );
  return { result: await session.send("read repeatedly"), provider };
}

await withTempProject(async (cwd) => {
  const { result, provider } = await runReadLoop(cwd, 0, 35);
  assert.equal(result.status, "completed");
  assert.equal(provider.calls.length, 36);
  assert(Math.max(...provider.calls.map((call) => call.messages.length)) < 50);
});

await withTempProject(async (cwd) => {
  const { result, provider } = await runReadLoop(cwd, 2, 5);
  assert.equal(result.status, "error");
  assert.equal(result.reason, "max_turns_exceeded");
  assert.equal(provider.calls.length, 2);
});

await withTempProject(async (cwd) => {
  const provider = new FakeProvider([
    {
      kind: "tool",
      call: toolCall("edit_1", "edit_file", {
        path: "sample.txt",
        old_string: "old",
        new_string: "new",
      }),
    },
    { kind: "final", text: "premature" },
    {
      kind: "tool",
      call: toolCall("read_1", "read_file", { path: "sample.txt", limit: 5 }),
    },
    { kind: "final", text: "reviewed" },
  ]);
  const policy = new PolicyEngine("agent");
  policy.approveSession("edit_file");
  const session = new Session(
    {
      cwd,
      mode: "agent",
      model: "deepseek-v4-pro",
      providerId: "deepseek",
      modelMode: "deepseek-high",
      agentCarefulness: "codex",
    },
    provider,
    policy,
    new ToolRegistry(),
    new ContextBuilder(),
    { maxTurns: 0 },
  );

  const result = await session.send("change sample");
  assert.equal(result.status, "completed");
  assert.equal(provider.calls.length, 4);
  assert.equal(provider.calls[1].generationConfig?.reasoning_effort, "max");
  assert.equal(provider.calls[2].generationConfig?.reasoning_effort, "max");
  assert(
    provider.calls[2].messages.some((message) =>
      typeof message.content === "string" && message.content.includes("Do not finalize yet."),
    ),
  );
});

await withTempProject(async (cwd) => {
  const provider = new FakeProvider([
    {
      kind: "tool",
      call: toolCall("read_steer", "read_file", { path: "sample.txt", limit: 5 }),
    },
    { kind: "final", text: "steered" },
  ]);
  const session = new Session(
    {
      cwd,
      mode: "ask",
      model: "deepseek-v4-pro",
      providerId: "deepseek",
      agentCarefulness: "standard",
    },
    provider,
    new PolicyEngine("ask"),
    new ToolRegistry(),
    new ContextBuilder(),
    { maxTurns: 0 },
  );
  session.on((event) => {
    if (event.type === "tool_result") {
      session.addSteering("Prefer the shortest valid answer.");
    }
  });
  const result = await session.send("read with steering");
  assert.equal(result.status, "completed");
  assert(
    provider.calls[1].messages.some((message) =>
      typeof message.content === "string" && message.content.includes("Live User Steering"),
    ),
  );
});

await withTempProject(async (cwd) => {
  const provider = new FakeProvider([{ kind: "final", text: "queued done" }]);
  const session = new Session(
    {
      cwd,
      mode: "ask",
      model: "deepseek-v4-pro",
      providerId: "deepseek",
      agentCarefulness: "standard",
    },
    provider,
    new PolicyEngine("ask"),
    new ToolRegistry(),
    new ContextBuilder(),
    { maxTurns: 0 },
  );
  const events = [];
  session.on((event) => events.push(event));
  const result = await session.sendQueuedPrompt("queued_1", "queued follow-up");
  assert.equal(result.status, "completed");
  assert(events.some((event) => event.type === "queued_prompt_started"));
  assert(session.getHistory().some((message) => message.role === "user" && message.content === "queued follow-up"));
});

await withTempProject(async (cwd) => {
  const dataDir = await mkdtemp(join(tmpdir(), "nhicode-carefulness-store-"));
  const manager = new SessionManager({
    dataDir,
    apiKeys: {
      deepseek: "test",
      qwen: "test",
      "kimi-code": "test",
    },
  });
  try {
    await manager.initialize(process.cwd());
    const deepseek = manager.createThread({
      cwd,
      providerId: "deepseek",
      model: "deepseek-v4-pro",
    });
    const kimiCode = manager.createThread({
      cwd,
      providerId: "kimi-code",
      model: "kimi-for-coding",
    });
    const qwen = manager.createThread({
      cwd,
      providerId: "qwen",
      model: "qwen3-coder-plus",
    });
    assert.equal(deepseek.getAgentCarefulness(), "codex");
    assert.equal(kimiCode.getAgentCarefulness(), "codex");
    assert.equal(qwen.getAgentCarefulness(), "codex");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

// Mode-aware tool definition filtering: ask mode must not advertise write tools.
await withTempProject(async (cwd) => {
  const provider = new FakeProvider([{ kind: "final", text: "filtered" }]);
  const session = new Session(
    {
      cwd,
      mode: "ask",
      model: "deepseek-v4-pro",
      providerId: "deepseek",
      agentCarefulness: "standard",
    },
    provider,
    new PolicyEngine("ask"),
    new ToolRegistry(),
    new ContextBuilder(),
    { maxTurns: 0 },
  );
  await session.send("what does this code do?");
  const toolNames = provider.calls[0].tools.map((tool) => tool.function.name);
  assert(toolNames.includes("read_file"));
  assert(toolNames.includes("git_status"));
  assert(toolNames.includes("expand_observation"));
  assert(!toolNames.includes("write_file"));
  assert(!toolNames.includes("edit_file"));
  assert(!toolNames.includes("shell"));
  assert(!toolNames.includes("git_commit"));
  assert(!toolNames.includes("spawn_subagent"));
});

// Broad review gate: multi-file edits reviewed only partially get one broader prompt.
await withTempProject(async (cwd) => {
  await writeFile(join(cwd, "second.txt"), "old2\n", "utf-8");
  const provider = new FakeProvider([
    { kind: "tool", call: toolCall("edit_a", "edit_file", { path: "sample.txt", old_string: "old", new_string: "new" }) },
    { kind: "tool", call: toolCall("edit_b", "edit_file", { path: "second.txt", old_string: "old2", new_string: "new2" }) },
    { kind: "tool", call: toolCall("read_a", "read_file", { path: "sample.txt", limit: 5 }) },
    { kind: "final", text: "too narrow" },
    { kind: "tool", call: toolCall("read_b", "read_file", { path: "second.txt", limit: 5 }) },
    { kind: "final", text: "broad done" },
  ]);
  const policy = new PolicyEngine("agent");
  policy.approveSession("edit_file");
  const session = new Session(
    {
      cwd,
      mode: "agent",
      model: "deepseek-v4-pro",
      providerId: "deepseek",
      agentCarefulness: "codex",
    },
    provider,
    policy,
    new ToolRegistry(),
    new ContextBuilder(),
    { maxTurns: 0 },
  );
  const result = await session.send("update both samples");
  assert.equal(result.status, "completed");
  assert.equal(result.text, "broad done");
  assert(
    provider.calls[4].messages.some(
      (message) =>
        typeof message.content === "string" &&
        message.content.includes("modified multiple files") &&
        message.content.includes("second.txt"),
    ),
  );
});

// Verification gate: an explicit "run the tests" request blocks finalizing until a check runs.
await withTempProject(async (cwd) => {
  const provider = new FakeProvider([
    { kind: "tool", call: toolCall("edit_v", "edit_file", { path: "sample.txt", old_string: "old", new_string: "new" }) },
    { kind: "tool", call: toolCall("read_v", "read_file", { path: "sample.txt", limit: 5 }) },
    { kind: "final", text: "skipped verification" },
    { kind: "tool", call: toolCall("shell_v", "shell", { command: "echo test" }) },
    { kind: "final", text: "verified" },
  ]);
  const policy = new PolicyEngine("agent");
  policy.approveSession("edit_file");
  policy.approveSession("shell");
  const session = new Session(
    {
      cwd,
      mode: "agent",
      model: "deepseek-v4-pro",
      providerId: "deepseek",
      agentCarefulness: "codex",
    },
    provider,
    policy,
    new ToolRegistry(),
    new ContextBuilder(),
    { maxTurns: 0 },
  );
  const result = await session.send("fix the sample and run the tests");
  assert.equal(result.status, "completed");
  assert.equal(result.text, "verified");
  assert(
    provider.calls[3].messages.some(
      (message) =>
        typeof message.content === "string" &&
        message.content.includes("tests or checks to be run"),
    ),
  );
});

// Reasoning compaction: older assistant reasoning is summarized, last 3 kept verbatim.
{
  const reasoning = "First sentence of thought. Followed by lots of extra detail.";
  const history = Array.from({ length: 5 }, (_, i) => ({
    role: "assistant",
    content: `answer ${i}`,
    reasoning_content: reasoning,
  }));
  const compacted = compactOlderReasoning(history);
  assert(compacted[0].reasoning_content.startsWith("[earlier reasoning summarized]"));
  assert(compacted[1].reasoning_content.startsWith("[earlier reasoning summarized]"));
  assert.equal(compacted[2].reasoning_content, reasoning);
  assert.equal(compacted[4].reasoning_content, reasoning);
  assert.equal(history[0].reasoning_content, reasoning); // originals untouched
}

// Expansion hint gating: only offered when raw output is meaningfully larger than compact.
{
  assert.equal(
    observationOffersExpansion({ rawTokenEstimate: 100, tokenEstimate: 95 }),
    false,
  );
  assert.equal(
    observationOffersExpansion({ rawTokenEstimate: 300, tokenEstimate: 100 }),
    true,
  );
}

console.log("carefulness self-test passed");
