import { assertEquals } from "jsr:@std/assert@1/equals";
import { userUnitStopArgs } from "./cleanup.ts";

Deno.test("builds one user service stop command", () => {
  assertEquals(userUnitStopArgs(["lm-qwen.service", "lm-worker.service"]), [
    "--user",
    "stop",
    "lm-qwen.service",
    "lm-worker.service",
  ]);
});
