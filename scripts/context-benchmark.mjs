import { buildBudgetedContext } from "../packages/context/dist/budget.js";

const now = new Date().toISOString();
const largeShellOutput = Array.from({ length: 5_000 }, (_, i) => `line ${i + 1}: build output`).join("\n");
const observations = Array.from({ length: 20 }, (_, i) => {
  const content = i % 3 === 0 ? largeShellOutput : `file ${i + 1}\n` + "source line\n".repeat(400);
  const compactContent =
    content.length > 3_000
      ? `${content.slice(0, 1_200)}\n\n[... compacted ...]\n\n${content.slice(-800)}`
      : content;
  return {
    id: `obs_${i + 1}`,
    threadId: "bench",
    toolCallId: `call_${i + 1}`,
    toolName: i % 3 === 0 ? "shell" : "read_file",
    kind: i % 3 === 0 ? "shell" : "file_read",
    summary: `Synthetic observation ${i + 1}`,
    content,
    compactContent,
    tokenEstimate: Math.ceil(compactContent.length / 4),
    rawTokenEstimate: Math.ceil(content.length / 4),
    createdAt: now,
  };
});

const result = buildBudgetedContext({
  systemPrompt: "You are NHI Code.",
  threadId: "bench",
  model: "deepseek-v4-pro",
  providerId: "deepseek",
  userMessage: "Continue the implementation.",
  workingMemory: "Original goal: implement context compaction and diagnostics.",
  dynamicContext: "Git status: many files changed.",
  observations,
  history: [
    { role: "user", content: "Implement the context plan." },
    { role: "assistant", content: "I will inspect and implement the pipeline." },
  ],
  budget: {
    maxContextTokens: 1_000_000,
    maxOutputTokens: 384_000,
    inputTokens: 128_000,
    outputReserveTokens: 64_000,
    toolReserveTokens: 16_000,
    recentTokens: 16_000,
    workingMemoryTokens: 6_000,
    observationTokens: 24_000,
    dynamicTokens: 2_000,
    fileEvidenceTokens: 48_000,
  },
});

const diagnostics = result.diagnostics;
const report = {
  estimatedInputTokens: diagnostics.estimatedInputTokens,
  inputBudgetTokens: diagnostics.inputBudgetTokens,
  suppressedObservationTokens: diagnostics.suppressedObservationTokens,
  messages: result.messages.length,
  slots: diagnostics.slots,
};

console.log(JSON.stringify(report, null, 2));

if (diagnostics.estimatedInputTokens > diagnostics.inputBudgetTokens) {
  console.error("Context benchmark exceeded input budget.");
  process.exit(1);
}
