import { assertEquals } from "jsr:@std/assert@1/equals";
import {
  isInferenceProcess,
  reservationActive,
  stoppableUnit,
  unitFromCgroup,
} from "./gpu_reservation.ts";

Deno.test("finds the owning unit of a cgroup v2 process", () => {
  assertEquals(
    unitFromCgroup("0::/user.slice/user-1000.slice/user@1000.service/app.slice/lm-qwen.service\n"),
    "lm-qwen.service",
  );
  assertEquals(
    unitFromCgroup("0::/user.slice/user-1000.slice/user@1000.service/app.slice/run-u42.service"),
    "run-u42.service",
  );
  assertEquals(unitFromCgroup("0::/user.slice/user-1000.slice/session-2.scope"), "session-2.scope");
  assertEquals(unitFromCgroup("0::/"), undefined);
});

Deno.test("stops services but never scopes or the user manager", () => {
  assertEquals(stoppableUnit("lm-qwen-test.service"), true);
  assertEquals(stoppableUnit("app-ghostty-1234.scope"), false);
  assertEquals(stoppableUnit("user@1000.service"), false);
  assertEquals(stoppableUnit(undefined), false);
});

Deno.test("recognizes inference backends wherever they are installed", () => {
  const dirs = new Set(["/opt/hipfire/release"]);
  assertEquals(isInferenceProcess("/x/llama-server", [], [], dirs), true);
  assertEquals(isInferenceProcess("/opt/hipfire/release/hipfire", [], [], dirs), true);
  assertEquals(isInferenceProcess("/opt/hipfire/release/daemon", [], [], dirs), true);
  assertEquals(isInferenceProcess("/usr/bin/daemon", [], [], dirs), false);
  assertEquals(isInferenceProcess("/opt/custom-server", [], ["/opt/custom-server"], dirs), true);
  assertEquals(isInferenceProcess("/usr/bin/ghostty", ["ghostty"], [], dirs), false);
});

Deno.test("recognizes lm-tools deploy processes but not other lm commands", () => {
  const deno = "/home/u/.deno/bin/deno";
  const dirs = new Set<string>();
  const deploy = [deno, "run", "-A", "/home/u/git/lm-tools/main.ts", "deploy", "q.json"];
  assertEquals(isInferenceProcess(deno, deploy, [], dirs), true);
  const status = [deno, "run", "-A", "/home/u/git/lm-tools/main.ts", "gpu", "status"];
  assertEquals(isInferenceProcess(deno, status, [], dirs), false);
});

Deno.test("a reservation lapses when its holder process exits", () => {
  const base = { owner: "steamvr", createdAt: "2026-10-22T00:00:00Z" };
  assertEquals(reservationActive({ ...base, pid: 10 }, () => true), true);
  assertEquals(reservationActive({ ...base, pid: 10 }, () => false), false);
  assertEquals(reservationActive(base, () => false), true);
});
