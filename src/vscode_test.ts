import { assertEquals } from "jsr:@std/assert@1/equals";
import { parsePromptProgressLine } from "./vscode.ts";

Deno.test("parses llama.cpp prompt evaluation progress", () => {
  assertEquals(
    parsePromptProgressLine(
      "slot print_timing: id  0 | task 55 | prompt processing, n_tokens =   8192, progress = 0.38, t = 590.78 s / 13.87 tokens per second",
    ),
    { taskId: 55, tokens: 8192, progress: 0.38 },
  );
});
