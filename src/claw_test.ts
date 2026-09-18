import { assertEquals } from "jsr:@std/assert@1/equals";
import { assertRejects } from "jsr:@std/assert@1/rejects";
import { assertThrows } from "jsr:@std/assert@1/throws";
import { clawAction, clawUsage, loadClaw } from "./claw.ts";

Deno.test("claw actions map to environment service actions", () => {
  assertEquals(clawAction("start"), "service-start");
  assertEquals(clawAction("restart"), "service-restart");
  assertEquals(clawAction("stop"), "service-stop");
  assertEquals(clawAction("check"), "check");
  assertEquals(clawAction("status"), "status");
  assertThrows(() => clawAction("attempt-once"));
});

Deno.test("usage documents claw as a standing-agent composition", () => {
  assertEquals(clawUsage().includes("unbounded standing agent"), true);
});

Deno.test("rejects a claw manifest whose harness is not a service harness", async () => {
  const manifest = {
    version: 2,
    name: "broken-claw",
    inference: { freeRouter: "missing.json" },
    harness: {
      kind: "attemptHarness",
      adapter: "omp-rpc",
      prompt: "/tmp/prompt.md",
      state: "/tmp/state.md",
      metricsDirectory: "/tmp/metrics",
      liveNoticePath: "/tmp/notice",
      dashboardPort: 8080,
      timeoutSeconds: 600,
      cooldownSeconds: 30,
      progressRepositories: [],
      cleanupProcesses: [],
    },
    environment: {
      backend: {
        kind: "incus",
        executable: "/usr/bin/incus",
        instance: "lm-test",
        image: "images:archlinux/current",
        network: { name: "incusbr0", device: "eth0" },
        limits: { cpu: 1, memory: "1GiB", processes: 64 },
        modelAccess: { host: "10.0.0.1", port: 1255 },
      },
      guest: {
        user: "agent",
        uid: 1000,
        gid: 1000,
        home: "/home/agent",
        workspace: "/home/agent/workspace",
        packages: [],
      },
    },
  };
  const path = await Deno.makeTempFile({ suffix: ".json" });
  await Deno.writeTextFile(path, JSON.stringify(manifest));
  try {
    await assertRejects(
      () => loadClaw(path),
      Error,
      "Invalid claw manifest",
    );
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("rejects a claw manifest without any inference", async () => {
  const manifest = {
    version: 2,
    name: "broken-claw",
    inference: {},
    harness: {
      kind: "service",
      command: ["/bin/true"],
      unit: "broken.service",
      restart: "no",
      restartSeconds: 5,
      restartPreventExitStatuses: [],
      ready: { command: ["/bin/true"], timeoutSeconds: 10 },
      restartOnRefresh: false,
    },
    environment: {
      backend: {
        kind: "incus",
        executable: "/usr/bin/incus",
        instance: "lm-test",
        image: "images:archlinux/current",
        network: { name: "incusbr0", device: "eth0" },
        limits: { cpu: 1, memory: "1GiB", processes: 64 },
        modelAccess: { host: "10.0.0.1", port: 1255 },
      },
      guest: {
        user: "agent",
        uid: 1000,
        gid: 1000,
        home: "/home/agent",
        workspace: "/home/agent/workspace",
        packages: [],
      },
    },
  };
  const path = await Deno.makeTempFile({ suffix: ".json" });
  await Deno.writeTextFile(path, JSON.stringify(manifest));
  try {
    await assertRejects(
      () => loadClaw(path),
      Error,
      "Invalid claw manifest",
    );
  } finally {
    await Deno.remove(path);
  }
});
