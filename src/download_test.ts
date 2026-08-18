import { assertEquals } from "jsr:@std/assert@1/equals";
import { planChunks } from "./download.ts";

Deno.test("plans byte ranges without overlap", () => {
  assertEquals(planChunks(10, 4), [
    { start: 0, end: 3 },
    { start: 4, end: 7 },
    { start: 8, end: 9 },
  ]);
});
