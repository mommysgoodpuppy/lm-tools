import { assertEquals } from "jsr:@std/assert@1/equals";
import {
  buildApplyPlan,
  buildHostServiceCommands,
  buildProvisionCommand,
  buildSeedCommands,
  loadAgentEnvironment,
} from "./agent_environment.ts";

const PROJECT_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

Deno.test("loads the PS2 Linux Incus environment", async () => {
  const environment = await loadAgentEnvironment(`${PROJECT_ROOT}/environments/ps2-linux.json`);
  assertEquals(environment.config.backend.kind, "incus");
  assertEquals(environment.config.backend.instance, "lm-ps2-linux");
  assertEquals(environment.config.backend.network.name, "incusbr-1000");
  assertEquals(environment.model.config.model.id, "qwen3.8-27b");
  assertEquals(environment.config.guest.packages.includes("xorg-server-xvfb"), true);
  assertEquals(environment.config.worker?.transport, "app-server");
});

Deno.test("loads the no-GPU Qwen tinygrad campaign environment", async () => {
  const environment = await loadAgentEnvironment(`${PROJECT_ROOT}/environments/qwen-tinygrad.json`);
  assertEquals(environment.config.backend.instance, "lm-qwen-tinygrad");
  assertEquals(environment.config.guest.workspace, "/home/ellie/git/tinygrad");
  assertEquals(environment.config.worker?.transport, "app-server");
  assertEquals(environment.config.worker?.wrapUpSeconds, 43200);
  assertEquals(environment.config.worker?.compaction, undefined);
  assertEquals(environment.config.worker?.phases?.map((phase) => phase.name), [
    "discovery",
    "implementation",
    "verification",
    "handoff",
  ]);
  assertEquals(environment.config.worker?.phaseControl, {
    requestPath: "/home/ellie/campaign/qwen-tinygrad/PHASE_REQUEST.json",
    maxTransitions: 64,
    maxWallSeconds: 43200,
    finalPhase: "handoff",
  });
  assertEquals(environment.config.worker?.turnSummary, {
    endpoint: "http://127.0.0.1:1235/v1/chat/completions",
    model: "qwen3.8-27b",
    reasoningEffort: "low",
    timeoutSeconds: 180,
    maxInputChars: 48000,
    maxOutputTokens: 1400,
  });
  assertEquals(environment.config.backend.modelAccess.port, 1245);
  assertEquals(environment.config.hostServices?.length, 5);
  const hostServices = buildHostServiceCommands(environment);
  assertEquals(hostServices.some((command) => command.args.includes("daemon-reload")), true);
  assertEquals(
    hostServices.some((command) => command.args.includes("lm-qwen-tinygrad-console.service")),
    true,
  );
  const refreshServices = buildHostServiceCommands(environment, true);
  assertEquals(
    refreshServices.some((command) =>
      command.args.includes("restart") &&
      command.args.includes("lm-qwen-tinygrad-console.service")
    ),
    true,
  );
  assertEquals(
    refreshServices.some((command) =>
      command.args.includes("restart") && command.args.includes("lm-qwen-tinygrad-agent.service")
    ),
    false,
  );
  assertEquals(
    buildApplyPlan(environment).some((command) => command.args.includes("gpu")),
    false,
  );
});

Deno.test("loads the Pi RPC alternative for the Qwen tinygrad worker", async () => {
  const environment = await loadAgentEnvironment(
    `${PROJECT_ROOT}/environments/qwen-tinygrad-pi.json`,
  );
  assertEquals(environment.config.backend.instance, "lm-qwen-tinygrad");
  assertEquals(environment.config.worker?.transport, "pi-rpc");
  assertEquals(environment.config.worker?.command?.includes("--no-session"), true);
  assertEquals(environment.config.guest.packages.includes("nodejs-lts-krypton"), true);
});

Deno.test("guest provisioning is declared and noninteractive", async () => {
  const environment = await loadAgentEnvironment(`${PROJECT_ROOT}/environments/ps2-linux.json`);
  const provision = buildProvisionCommand(environment);
  assertEquals(provision.executable, "/usr/bin/incus");
  assertEquals(provision.args.includes("--noconfirm"), true);
  assertEquals(provision.args.includes("--needed"), true);
  assertEquals(provision.args.includes("codex"), false);
});

Deno.test("Incus plan is unprivileged and has no host device passthrough", async () => {
  const environment = await loadAgentEnvironment(`${PROJECT_ROOT}/environments/ps2-linux.json`);
  const plan = buildApplyPlan(environment).map((command) => command.args.join(" "));
  assertEquals(plan.some((command) => command.includes("security.privileged=false")), true);
  assertEquals(plan.some((command) => command.includes("security.nesting=false")), true);
  assertEquals(environment.config.backend.modelAccess.host, "10.248.172.1");
  assertEquals(plan.some((command) => command.includes(" proxy ")), false);
  assertEquals(plan.some((command) => command.includes(" type=disk ")), false);
});

Deno.test("seeds use filtered tar streams rather than host disk devices", async () => {
  const environment = await loadAgentEnvironment(`${PROJECT_ROOT}/environments/ps2-linux.json`);
  const commands = buildSeedCommands(environment);
  const archives = commands.filter((command) => command.executable === "/usr/bin/tar");
  assertEquals(archives.length, environment.config.seeds.length);
  assertEquals(
    archives.some((command) => command.args.includes("--exclude=ps2linuxPCSX2/test/boot11.log")),
    true,
  );
  assertEquals(commands.some((command) => command.args.includes("disk")), false);
  assertEquals(environment.config.seeds.filter((seed) => seed.refresh).length >= 3, true);
  assertEquals(
    commands.some((command) =>
      command.args.includes("chown") && command.args.includes("1000:1000")
    ),
    true,
  );
  assertEquals(
    environment.config.seeds.some((seed) =>
      seed.source.endsWith("ps2-linux-worker/STATE.md") && !seed.refresh
    ),
    true,
  );
});
