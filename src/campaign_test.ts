import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import { join } from "jsr:@std/path@1";
import { canonicalJson, defineCampaign, runCampaign } from "./campaign.ts";

Deno.test("canonical campaign fingerprints ignore object key order", () => {
  assertEquals(canonicalJson({ b: 2, a: { d: 4, c: 3 } }), '{"a":{"c":3,"d":4},"b":2}');
});

Deno.test("campaign programs return arbitrary values and reuse named attempt effects", async () => {
  const stateDirectory = await Deno.makeTempDir();
  let executions = 0;
  try {
    const campaign = defineCampaign({
      id: "research",
      async run(context) {
        const attempt = await context.attempt(
          {
            operation: "inspect-renderer",
            inputs: { artifact: "sha256:abc", question: ["facet", "present"] },
          },
          async (workspace) => {
            executions += 1;
            await Deno.writeTextFile(
              join(workspace.artifactsDirectory, "free-form-notes.txt"),
              "No universal research result shape.\n",
            );
            return { termination: { kind: "completed", exitCode: 0 } };
          },
        );
        return {
          attempt,
          arbitraryInterpretation: new Map([["next", ["inspect factory", "recover type"]]]),
        };
      },
    });

    const first = await runCampaign(campaign, { stateDirectory });
    const second = await runCampaign(campaign, { stateDirectory });
    assertEquals(executions, 1);
    assertEquals(first.attempt.id, second.attempt.id);
    assertEquals(first.attempt.artifacts.length, 1);
    assertEquals(first.attempt.artifacts[0].path, "free-form-notes.txt");
    assertEquals(first.arbitraryInterpretation.get("next")?.length, 2);
  } finally {
    await Deno.remove(stateDirectory, { recursive: true });
  }
});

Deno.test("changing campaign-selected inputs creates a distinct attempt", async () => {
  const stateDirectory = await Deno.makeTempDir();
  let executions = 0;
  try {
    const run = (revision: string) =>
      runCampaign(
        defineCampaign({
          id: "research",
          async run(context) {
            return await context.attempt(
              { operation: "inspect", inputs: { revision } },
              () => {
                executions += 1;
                return Promise.resolve({ termination: { kind: "completed", exitCode: 0 } });
              },
            );
          },
        }),
        { stateDirectory },
      );
    const first = await run("one");
    const second = await run("two");
    assertEquals(executions, 2);
    assertEquals(first.id === second.id, false);
  } finally {
    await Deno.remove(stateDirectory, { recursive: true });
  }
});

Deno.test("concurrent campaign processes cannot claim the same attempt twice", async () => {
  const stateDirectory = await Deno.makeTempDir();
  let executions = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => release = resolve);
  const campaign = defineCampaign({
    id: "research",
    async run(context) {
      return await context.attempt(
        { operation: "exclusive", inputs: { revision: 1 } },
        async () => {
          executions += 1;
          await held;
          return { termination: { kind: "completed", exitCode: 0 } };
        },
      );
    },
  });
  try {
    const first = runCampaign(campaign, { stateDirectory });
    while (executions === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    await assertRejects(
      () => runCampaign(campaign, { stateDirectory }),
      Error,
      "unfinished running record",
    );
    release();
    await first;
    assertEquals(executions, 1);
  } finally {
    release();
    await Deno.remove(stateDirectory, { recursive: true });
  }
});

Deno.test("attempt failures become durable operational records", async () => {
  const stateDirectory = await Deno.makeTempDir();
  let executions = 0;
  try {
    const campaign = defineCampaign({
      id: "research",
      async run(context) {
        return await context.attempt(
          { operation: "failed-probe", inputs: null },
          () => {
            executions += 1;
            throw new Error("probe unavailable");
          },
        );
      },
    });
    const first = await runCampaign(campaign, { stateDirectory });
    const second = await runCampaign(campaign, { stateDirectory });
    assertEquals(executions, 1);
    assertEquals(first.termination, { kind: "failed", error: "probe unavailable" });
    assertEquals(second, first);
  } finally {
    await Deno.remove(stateDirectory, { recursive: true });
  }
});

Deno.test("campaign ids and artifact symlinks fail closed", async () => {
  assertThrows(
    () => defineCampaign({ id: "../escape", async run() {} }),
    Error,
    "Campaign id",
  );

  const stateDirectory = await Deno.makeTempDir();
  const outside = join(stateDirectory, "outside.txt");
  await Deno.writeTextFile(outside, "outside");
  try {
    const campaign = defineCampaign({
      id: "research",
      async run(context) {
        return await context.attempt(
          { operation: "symlink", inputs: null },
          async (workspace) => {
            await Deno.symlink(outside, join(workspace.artifactsDirectory, "outside"));
            return { termination: { kind: "completed", exitCode: 0 } };
          },
        );
      },
    });
    await assertRejects(
      () => runCampaign(campaign, { stateDirectory }),
      Error,
      "may not contain symlinks",
    );
  } finally {
    await Deno.remove(stateDirectory, { recursive: true });
  }
});
