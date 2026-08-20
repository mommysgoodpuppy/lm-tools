import { assertEquals } from "jsr:@std/assert@1/equals";
import { buildLlamaArgs, parseContext, parseLlamaArgs } from "./llama.ts";

Deno.test("parses friendly context sizes", () => {
  assertEquals(parseContext("8192"), 8192);
  assertEquals(parseContext("64k"), 65536);
  assertEquals(parseContext("1M"), 1048576);
});

Deno.test("builds a configurable llama command", () => {
  const options = parseLlamaArgs(
    [
      "model.gguf",
      "--context",
      "32k",
      "--kv",
      "q4_0",
      "--mtp",
      "2",
      "--no-webui",
      "--",
      "--verbose",
    ],
    {},
  );
  const args = buildLlamaArgs(options);
  assertEquals(options.model, "model.gguf");
  assertEquals(options.context, 32768);
  assertEquals(options.cacheTypeK, "q4_0");
  assertEquals(options.cacheTypeV, "q4_0");
  assertEquals(options.mtpDraftTokens, 2);
  assertEquals(args.includes("--webui"), false);
  assertEquals(args.includes("draft-mtp"), true);
  assertEquals(args[args.indexOf("--spec-draft-n-max") + 1], "2");
  assertEquals(args.at(-1), "--verbose");
});

Deno.test("can disable MTP explicitly", () => {
  const options = parseLlamaArgs(["model.gguf", "--mtp", "0"], {});
  assertEquals(options.mtpDraftTokens, 0);
  assertEquals(buildLlamaArgs(options).includes("--spec-type"), false);
});
