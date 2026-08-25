import { assertEquals } from "jsr:@std/assert@1/equals";
import { assertThrows } from "jsr:@std/assert@1";
import {
  compactTurnTranscript,
  parseCodexEventUsage,
  parsePiRpcEvents,
  parseTurnResearchSummary,
  validateWorkerPhaseRequest,
} from "./agent_worker.ts";

Deno.test("parses a fenced structured turn research summary", () => {
  const parsed = parseTurnResearchSummary(
    `\`\`\`json
  {
    "title": "Mapped the opaque prefill graphs",
    "status": "measurement-requested",
    "summary": "The turn established that graph-level timing is insufficient. No production kernel was changed.",
    "outcome": "Requested a JIT=2 attribution profile.",
    "evidence": ["99.97% of observed GPU time was in four batched graphs."],
    "changes": ["Updated the durable hypothesis and handoff."],
    "nextStep": "Run the declared host profile and attribute per-program cost."
  }
  \`\`\``,
    "run-7",
  );
  assertEquals(parsed.runId, "run-7");
  assertEquals(parsed.status, "measurement-requested");
  assertEquals(parsed.source, "qwen-generated");
  assertEquals(parsed.evidence.length, 1);
});

Deno.test("compacts only durable high-signal turn events", () => {
  const transcript = compactTurnTranscript([
    JSON.stringify({ method: "item/reasoning/textDelta", params: { delta: "noise" } }),
    JSON.stringify({
      method: "item/completed",
      params: { item: { type: "agentMessage", text: "The probe falsified the CPU surrogate." } },
    }),
    JSON.stringify({ type: "lm_tools.phase_completed", phase: "implementation", exitCode: 0 }),
  ], 4000);
  assertEquals(transcript.includes("noise"), false);
  assertEquals(transcript.includes("falsified the CPU surrogate"), true);
  assertEquals(transcript.includes("phase_completed"), true);
});

Deno.test("validates model-directed phase transitions", () => {
  const phases = ["discovery", "implementation", "verification", "handoff"];
  assertEquals(
    validateWorkerPhaseRequest({
      version: 1,
      next: "discovery",
      reason: "new evidence",
    }, phases),
    { version: 1, next: "discovery", reason: "new evidence" },
  );
  assertThrows(
    () => validateWorkerPhaseRequest({ version: 1, next: "unknown" }, phases),
    Error,
    "Invalid requested worker phase",
  );
});

Deno.test("parses Codex JSONL usage and final summary", () => {
  const parsed = parseCodexEventUsage([
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "first update" },
    }),
    "not json",
    JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 1200, cached_input_tokens: 700, output_tokens: 300 },
    }),
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "verified progress" },
    }),
  ]);
  assertEquals(parsed.usage, {
    inputTokens: 1200,
    cachedInputTokens: 700,
    outputTokens: 300,
    totalTokens: 1500,
  });
  assertEquals(parsed.finalMessage, "verified progress");
  assertEquals(parsed.compactions, 0);
  assertEquals(parsed.semanticCompactions, 0);
  assertEquals(parsed.compactionReminders, 0);
});

Deno.test("parses Pi RPC stats, compactions, and final text", () => {
  const parsed = parsePiRpcEvents([
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "fallback" }],
        usage: { input: 10, output: 4, cacheRead: 6, totalTokens: 14 },
      },
    }),
    JSON.stringify({ type: "compaction_end", aborted: false, result: { summary: "state" } }),
    JSON.stringify({
      id: "lm-tools-stats",
      type: "response",
      command: "get_session_stats",
      success: true,
      data: { tokens: { input: 2400, output: 450, cacheRead: 1800, total: 2850 } },
    }),
    JSON.stringify({
      id: "lm-tools-final",
      type: "response",
      command: "get_last_assistant_text",
      success: true,
      data: { text: "Pi session complete" },
    }),
  ]);
  assertEquals(parsed.usage, {
    inputTokens: 2400,
    cachedInputTokens: 1800,
    outputTokens: 450,
    totalTokens: 2850,
  });
  assertEquals(parsed.finalMessage, "Pi session complete");
  assertEquals(parsed.compactions, 1);
  assertEquals(parsed.semanticCompactions, 0);
  assertEquals(parsed.compactionReminders, 0);
});

Deno.test("parses app-server usage and final summary", () => {
  const parsed = parseCodexEventUsage([
    JSON.stringify({
      method: "thread/tokenUsage/updated",
      params: {
        tokenUsage: {
          total: {
            inputTokens: 2400,
            cachedInputTokens: 1800,
            outputTokens: 450,
            reasoningOutputTokens: 200,
            totalTokens: 2850,
          },
        },
      },
    }),
    JSON.stringify({
      type: "lm_tools.context_reminder",
      activeTokens: 41000,
      thresholdTokens: 40000,
    }),
    JSON.stringify({
      method: "item/completed",
      params: { item: { type: "agentMessage", text: "streamed turn complete" } },
    }),
    JSON.stringify({
      method: "item/completed",
      params: {
        item: { type: "dynamicToolCall", tool: "compact_context", status: "completed" },
      },
    }),
    JSON.stringify({
      method: "item/completed",
      params: { item: { type: "contextCompaction" } },
    }),
  ]);
  assertEquals(parsed.usage, {
    inputTokens: 2400,
    cachedInputTokens: 1800,
    outputTokens: 450,
    totalTokens: 2850,
  });
  assertEquals(parsed.finalMessage, "streamed turn complete");
  assertEquals(parsed.compactions, 1);
  assertEquals(parsed.semanticCompactions, 1);
  assertEquals(parsed.compactionReminders, 1);
});

Deno.test("sums app-server usage across fresh phased threads", () => {
  const parsed = parseCodexEventUsage([
    JSON.stringify({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "triage",
        tokenUsage: {
          total: {
            inputTokens: 1000,
            cachedInputTokens: 800,
            outputTokens: 200,
            totalTokens: 1200,
          },
        },
      },
    }),
    JSON.stringify({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "triage",
        tokenUsage: {
          total: {
            inputTokens: 1800,
            cachedInputTokens: 1500,
            outputTokens: 400,
            totalTokens: 2200,
          },
        },
      },
    }),
    JSON.stringify({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "implementation",
        tokenUsage: {
          total: {
            inputTokens: 900,
            cachedInputTokens: 500,
            outputTokens: 300,
            totalTokens: 1200,
          },
        },
      },
    }),
  ]);
  assertEquals(parsed.usage, {
    inputTokens: 2700,
    cachedInputTokens: 2000,
    outputTokens: 700,
    totalTokens: 3400,
  });
});
