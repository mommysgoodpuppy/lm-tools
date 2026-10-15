import { assertEquals } from "jsr:@std/assert@1";
import { join } from "jsr:@std/path@1";
import type { ResolvedAgentEnvironment } from "./agent_environment.ts";
import { defineCampaign, runCampaign } from "./campaign.ts";
import { type OmpAttemptRunner, runOmpCampaignAttempt } from "./campaign_omp.ts";

Deno.test("OMP campaign adapter preserves program identity and captures raw harness artifacts", async () => {
  const stateDirectory = await Deno.makeTempDir();
  let executions = 0;
  let receivedPrompt: string | undefined;
  let receivedMetricsDirectory: string | undefined;
  let receivedModel: string | undefined;
  const environment = { sourcePath: "/environment.json" } as ResolvedAgentEnvironment;
  const runner: OmpAttemptRunner = async (_environment, options) => {
    executions += 1;
    receivedPrompt = options.promptText;
    receivedMetricsDirectory = options.metricsDirectory;
    receivedModel = options.model;
    await Deno.mkdir(options.metricsDirectory!, { recursive: true });
    await Deno.writeTextFile(join(options.metricsDirectory!, "events.jsonl"), '{"type":"ready"}\n');
    return {
      run: {
        id: "native-run",
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:01.000Z",
        durationSeconds: 1,
        exitCode: 0,
        timedOut: false,
        usage: { inputTokens: 3, cachedInputTokens: 2, outputTokens: 1, totalTokens: 4 },
        compactions: 0,
        semanticCompactions: 0,
        compactionReminders: 0,
        eventLog: join(options.metricsDirectory!, "events.jsonl"),
        stateBefore: null,
        stateAfter: null,
        repositoriesBefore: {},
        repositoriesAfter: {},
        finalMessage: "done",
      },
      ledger: {
        version: 1,
        environment: "test",
        startedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:01.000Z",
        runs: 1,
        successfulRuns: 1,
        failedRuns: 0,
        wallSeconds: 1,
        usage: { inputTokens: 3, cachedInputTokens: 2, outputTokens: 1, totalTokens: 4 },
        compactions: 0,
        semanticCompactions: 0,
        compactionReminders: 0,
        history: [],
      },
    };
  };
  try {
    const campaign = defineCampaign({
      id: "omp-adapter-test",
      async run(context) {
        return await runOmpCampaignAttempt(
          context,
          {
            identity: { operation: "inspect", inputs: { target: "sha256:abc", pass: 1 } },
            environment,
            prompt: "Inspect the selected function.",
            model: "provider/model",
          },
          runner,
        );
      },
    });
    const first = await runCampaign(campaign, { stateDirectory });
    const second = await runCampaign(campaign, { stateDirectory });

    assertEquals(executions, 1);
    assertEquals(receivedPrompt, "Inspect the selected function.");
    assertEquals(receivedMetricsDirectory?.endsWith("/artifacts/harness"), true);
    assertEquals(receivedModel, "provider/model");
    assertEquals(first, second);
    assertEquals(first.termination, { kind: "completed", exitCode: 0 });
    assertEquals(first.usage?.totalTokens, 4);
    assertEquals(first.artifacts.map((artifact) => artifact.path), [
      "harness/events.jsonl",
      "prompt.md",
    ]);
  } finally {
    await Deno.remove(stateDirectory, { recursive: true });
  }
});
