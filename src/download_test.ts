import { assertEquals } from "jsr:@std/assert@1/equals";
import { planChunks, recommendedConnections, verifyFileIntegrity } from "./download.ts";

Deno.test("plans byte ranges without overlap", () => {
  assertEquals(planChunks(10, 4), [
    { start: 0, end: 3 },
    { start: 4, end: 7 },
    { start: 8, end: 9 },
  ]);
});

Deno.test("uses more range workers for Hugging Face artifacts", () => {
  assertEquals(recommendedConnections(new URL("https://huggingface.co/org/model/file.gguf")), 16);
  assertEquals(recommendedConnections(new URL("https://example.com/file.gguf")), 8);
});

Deno.test("verifies an artifact by size and SHA-256", async () => {
  const path = await Deno.makeTempFile({ prefix: "lm-tools-integrity-" });
  try {
    await Deno.writeTextFile(path, "talkie\n");
    await verifyFileIntegrity(
      path,
      7,
      "491d94490626946f10f42d1c7738b3d875bb823c06451f369185cb5deff788d1",
    );
  } finally {
    await Deno.remove(path);
  }
});
