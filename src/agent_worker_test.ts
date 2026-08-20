import { assertEquals } from "jsr:@std/assert@1/equals";
import { parseCodexEventUsage } from "./agent_worker.ts";

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
      method: "item/completed",
      params: { item: { type: "agentMessage", text: "streamed turn complete" } },
    }),
  ]);
  assertEquals(parsed.usage, {
    inputTokens: 2400,
    cachedInputTokens: 1800,
    outputTokens: 450,
    totalTokens: 2850,
  });
  assertEquals(parsed.finalMessage, "streamed turn complete");
});
