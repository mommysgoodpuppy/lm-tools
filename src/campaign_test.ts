import { assertEquals, assertNotEquals, assertThrows } from "jsr:@std/assert@1";
import {
  campaignUsage,
  candidateHash,
  classifyEvaluatorFailure,
  loadCampaign,
  median,
  summarizeTinygradProfile,
  validateEvaluationRequest,
} from "./campaign.ts";

const PROJECT_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

Deno.test("documents operator pause and resume actions", () => {
  assertEquals(campaignUsage().includes("--pause"), true);
  assertEquals(campaignUsage().includes("--resume"), true);
});

Deno.test("replaces an opaque fetch error with the AMD hardware fault from evaluator logs", () => {
  assertEquals(
    classifyEvaluatorFailure(
      "fetch failed",
      "traceback\nRuntimeError: HW fault: reset_type=0 reset_cause=0 memory_lost=1 gpu_id=65383\n",
    ),
    "AMD GPU fault during candidate execution: HW fault: reset_type=0 reset_cause=0 memory_lost=1 gpu_id=65383",
  );
  assertEquals(classifyEvaluatorFailure("fetch failed", "ordinary stderr"), "fetch failed");
});

Deno.test("loads the Qwen tinygrad campaign and its worker environment", async () => {
  const campaign = await loadCampaign(`${PROJECT_ROOT}/campaigns/qwen-tinygrad.json`);
  assertEquals(campaign.config.name, "qwen-tinygrad-self-optimize");
  assertEquals(campaign.config.harness.kind, "codex-app-server");
  assertEquals(campaign.config.loop, {
    successCooldownSeconds: 60,
    failureCooldownSeconds: 300,
    restartRequestPath: `${PROJECT_ROOT}/logs/agent-campaigns/qwen-tinygrad/restart-request.json`,
    pausePath: `${PROJECT_ROOT}/logs/agent-campaigns/qwen-tinygrad/paused.json`,
    controllerService: "lm-qwen-tinygrad-campaign.service",
  });
  assertEquals(campaign.environment.config.backend.instance, "lm-qwen-tinygrad");
  assertEquals(campaign.environment.config.worker?.wrapUpSeconds, 43200);
  assertEquals(campaign.environment.config.worker?.phases?.length, 4);
  assertEquals(campaign.config.evaluator.tiers.map((tier) => tier.name), [
    "screen",
    "promote",
    "final",
  ]);
  assertEquals(campaign.config.evaluator.tiers[0].expectedPromptTokens, 7672);
  assertEquals(campaign.config.evaluator.probeRunners.map((runner) => runner.name), [
    "python-amd",
  ]);
  assertEquals(
    campaign.config.workspace.guestEvaluationArtifactsDirectory,
    campaign.config.workspace.candidatesDirectory,
  );
});

Deno.test("accepts only declared candidate-relative AMD probes", async () => {
  const campaign = await loadCampaign(`${PROJECT_ROOT}/campaigns/qwen-tinygrad.json`);
  assertEquals(
    validateEvaluationRequest({
      version: 1,
      kind: "probe",
      focus: "gated-delta correctness",
      probe: { runner: "python-amd", path: "test/campaign/gated_delta.py" },
      environment: { DEBUG: "2", JIT: "1" },
    }, campaign),
    {
      version: 1,
      kind: "probe",
      focus: "gated-delta correctness",
      probe: { runner: "python-amd", path: "test/campaign/gated_delta.py" },
      environment: { DEBUG: "2", JIT: "1" },
    },
  );
  assertThrows(
    () =>
      validateEvaluationRequest({
        version: 1,
        kind: "probe",
        probe: { runner: "python-amd", path: "../escape.py" },
      }, campaign),
    Error,
    "normalized candidate-relative path",
  );
  assertThrows(
    () =>
      validateEvaluationRequest({
        version: 1,
        kind: "probe",
        probe: { runner: "shell", path: "test/campaign/probe.py" },
      }, campaign),
    Error,
    "Unknown probe runner",
  );
  assertThrows(
    () =>
      validateEvaluationRequest({
        version: 1,
        kind: "probe",
        probe: { runner: "python-amd", path: "test/unit/test_gguf.py" },
      }, campaign),
    Error,
    "allowed prefixes",
  );
});

Deno.test("loads the isolated Pi RPC campaign variant", async () => {
  const campaign = await loadCampaign(`${PROJECT_ROOT}/campaigns/qwen-tinygrad-pi.json`);
  assertEquals(campaign.config.name, "qwen-tinygrad-self-optimize-pi");
  assertEquals(campaign.config.harness.kind, "pi-rpc");
  assertEquals(campaign.environment.config.worker?.transport, "pi-rpc");
  assertEquals(
    campaign.config.workspace.candidatesDirectory.includes("qwen-tinygrad-pi"),
    true,
  );
});

Deno.test("computes medians for evaluator repetitions", () => {
  assertEquals(median([3, 1, 2]), 2);
  assertEquals(median([4, 1, 3, 2]), 2.5);
});

Deno.test("summarizes tinygrad DEBUG kernels after server startup", () => {
  const summary = summarizeTinygradProfile(
    [
      "*** AMD 1 gated_delta_prefill arg 8 mem 1 GB tm 2.00ms/2.00ms",
      "*** started server on http://127.0.0.1:8000 at 5.0 s",
      "*** AMD 2 batched 1024 arg 0 mem 2 GB tm 10.00ms/12.00ms",
      "*** AMD 3 batched 512 arg 0 mem 2 GB tm 5000.00us/17.00ms",
      "*** AMD 4 q8_quantize arg 3 mem 2 GB tm 1.00ms/18.00ms",
    ].join("\n"),
    "/tmp/server.stdout.log",
  );
  assertEquals(summary.scope, "after-server-start");
  assertEquals(summary.opaqueGraphReplay, true);
  assertEquals(summary.kernelCount, 3);
  assertEquals(summary.kernelTimeMs, 16);
  assertEquals(summary.families[0], {
    name: "captured_graph",
    count: 2,
    totalMs: 15,
    averageMs: 7.5,
    percentKernelTime: 93.75,
  });
  assertEquals(summary.topKernels[0].name, "batched 1024");
});

Deno.test("candidate identity changes with an untracked source file", async () => {
  const temporary = await Deno.makeTempDir({ prefix: "lm-tools-candidate-test-" });
  const checkout = `${temporary}/tinygrad`;
  try {
    const clone = await new Deno.Command("/usr/bin/git", {
      args: ["clone", "--quiet", "--shared", `${PROJECT_ROOT}/vendor/tinygrad`, checkout],
    }).output();
    assertEquals(clone.success, true);
    const before = await candidateHash(checkout);
    await Deno.writeTextFile(`${checkout}/campaign_probe.py`, "VALUE = 1\n");
    assertNotEquals(await candidateHash(checkout), before);
  } finally {
    await Deno.remove(temporary, { recursive: true });
  }
});
