import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { parseBenchmarkArgs, responsesToChatCompletions, truncateRoleInput } from "./benchmark.ts";

Deno.test("converts a role-based Responses request to Chat Completions", () => {
  assertEquals(
    responsesToChatCompletions({
      model: "qwen",
      input: [
        { role: "developer", content: "system" },
        { role: "user", content: [{ type: "input_text", text: "hello" }] },
      ],
      tools: [{ type: "function", name: "read", description: "Read", parameters: {} }],
      max_output_tokens: 128,
    }),
    {
      model: "qwen",
      messages: [
        { role: "developer", content: "system" },
        { role: "user", content: "hello" },
      ],
      tools: [{
        type: "function",
        function: { name: "read", description: "Read", parameters: {} },
      }],
      stream: false,
      max_completion_tokens: 128,
    },
  );
});

Deno.test("selects a benchmark endpoint from the requested API", () => {
  assertEquals(parseBenchmarkArgs(["request.json"]).url, "http://127.0.0.1:1235/v1/responses");
  assertEquals(
    parseBenchmarkArgs(["request.json", "--api", "chat-completions"]).url,
    "http://127.0.0.1:8000/v1/chat/completions",
  );
  assertThrows(
    () => responsesToChatCompletions({ input: [{ type: "function_call" }] }),
    Error,
    "Unsupported Responses input item",
  );
});

Deno.test("truncates role input across string and array content", () => {
  const request = {
    input: [
      { role: "developer", content: "abc" },
      { role: "user", content: [{ type: "input_text", text: "defgh" }] },
    ],
  };
  truncateRoleInput(request, 5);
  assertEquals(request.input, [
    { role: "developer", content: "abc" },
    { role: "user", content: [{ type: "input_text", text: "de" }] },
  ]);
  assertEquals(
    parseBenchmarkArgs([
      "request.json",
      "--max-input-chars",
      "28000",
      "--expect-prompt-tokens",
      "7672",
    ]),
    {
      requestPath: "request.json",
      api: "responses",
      url: "http://127.0.0.1:1235/v1/responses",
      maxInputChars: 28000,
      expectedPromptTokens: 7672,
      maxOutputTokens: undefined,
      outputPath: undefined,
      vramDevice: undefined,
    },
  );
});
