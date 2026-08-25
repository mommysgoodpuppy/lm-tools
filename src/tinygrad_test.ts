import { assertEquals } from "jsr:@std/assert@1/equals";
import { buildTinygradCommand, parseTinygradArgs } from "./tinygrad.ts";

Deno.test("builds the native AMD tinygrad Qwen command", () => {
  const options = parseTinygradArgs(
    ["--recurrent-chunk", "16", "model.gguf", "--max_context", "4096"],
    {},
  );
  const command = buildTinygradCommand(options, "/repo");
  assertEquals(command.command, "python3");
  assertEquals(command.args, [
    "-m",
    "tinygrad.llm",
    "--model",
    "model.gguf",
    "--max_context",
    "4096",
  ]);
  assertEquals(command.env.DEV, "AMD");
  assertEquals(command.env.JIT, "1");
  assertEquals(command.env.PYTHONPATH, "/repo/vendor/tinygrad");
  assertEquals(command.env.TINYGRAD_RECURRENT_CHUNK_SIZE, "16");
});

Deno.test("allows overriding tinygrad JIT mode", () => {
  const options = parseTinygradArgs(["--jit", "3", "model.gguf"], {});
  assertEquals(options.jit, 3);
});

Deno.test("uses an explicitly configured default tinygrad model", () => {
  const options = parseTinygradArgs(["--benchmark", "3"], { TINYGRAD_MODEL: "/models/qwen.gguf" });
  assertEquals(options.tinygradArgs, ["--model", "/models/qwen.gguf", "--benchmark", "3"]);
});
