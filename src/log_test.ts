import { assertEquals } from "jsr:@std/assert@1/equals";
import { assertRejects } from "jsr:@std/assert@1/rejects";
import { AppendOnlyTextLog, DiagnosticLog, TextLogCapacityError } from "./log.ts";

Deno.test("captures complete request bodies beside the diagnostic log", async () => {
  const directory = await Deno.makeTempDir({ prefix: "lm-tools-log-test-" });
  try {
    const log = new DiagnosticLog(`${directory}/lm-tools.jsonl`);
    const body = new TextEncoder().encode(
      JSON.stringify({ input: [{ role: "user", content: "complete prompt" }] }),
    ).buffer;
    const capture = await log.captureRequest("request/unsafe", body);
    log.log("proxy", "request", { requestCapture: capture });
    await log.flush();

    assertEquals(await Deno.readTextFile(capture), new TextDecoder().decode(body));
    assertEquals(capture.startsWith(`${directory}/requests/`), true);
    assertEquals(capture.includes("request_unsafe"), true);
    assertEquals((await Deno.readTextFile(log.path)).includes(capture), true);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("append-only text logs stop before crossing their hard capacity", async () => {
  const directory = await Deno.makeTempDir({ prefix: "lm-tools-capacity-test-" });
  const path = `${directory}/audit.jsonl`;
  let capacityErrors = 0;
  try {
    const log = new AppendOnlyTextLog(path, {
      maximumBytes: 5,
      onCapacityExceeded: () => capacityErrors += 1,
    });
    await log.append("1234");
    await assertRejects(() => log.append("56"), TextLogCapacityError);
    assertEquals(await Deno.readTextFile(path), "1234");
    assertEquals(log.bytes, 4);
    assertEquals(capacityErrors, 1);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
