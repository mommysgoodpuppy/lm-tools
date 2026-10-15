# Campaign programs

Campaigns are trusted programs built from lm-tools deployment primitives. They are not JSON-defined
workflows and lm-tools does not prescribe a research-task or result schema.

This distinction is intentional. Environments and harness profiles describe operational objects
whose shape is stable: isolation, mounts, tools, runtime versions, and invocation policy. Research
questions, useful evidence, scoring, follow-up strategy, and the meaning of success evolve with the
consuming project and belong in its code.

## API boundary

`src/campaign.ts` currently provides the first small kernel:

```ts
import { defineCampaign, runCampaign } from "/path/to/lm-tools/src/campaign.ts";

const campaign = defineCampaign({
  id: "wired-vr",
  async run(ctx) {
    const attempt = await ctx.attempt(
      {
        operation: "renderer-roles",
        inputs: {
          artifact: "sha256:...",
          programModelRevision: "...",
          harnessRevision: "...",
          environmentRevision: "...",
        },
      },
      async (workspace) => {
        // Materialize and run OMP through the existing harness machinery.
        // Write arbitrary native records and research output beneath:
        // workspace.artifactsDirectory
        return { termination: { kind: "completed", exitCode: 0 } };
      },
    );

    // Interpretation is ordinary project code. Its value is not constrained,
    // validated, or persisted by the campaign kernel.
    return interpretRendererAttempt(attempt);
  },
});

await runCampaign(campaign, { stateDirectory: "artifacts/campaigns/wired-vr" });
```

A named attempt is a durable idempotent effect. Its identity is the campaign id, operation name, and
canonical fingerprint of the arbitrary JSON inputs chosen by the campaign. Rerunning the program
returns the recorded operational attempt instead of launching it again. A deliberate retry, branch,
or changed interpretation input therefore changes the fingerprint explicitly.

The attempt workspace contains `input.json`, an operational `record.json`, and an `artifacts/` tree.
lm-tools inventories regular files in that tree by relative path, size, and SHA-256. Symlinks fail
closed. The artifacts themselves can be anything: OMP sessions, raw events, decompiler output,
notes, patches, databases, or a project-specific result file.

## Stable and open-ended state

The stable attempt record answers only operational questions:

- what named effect and input fingerprint ran;
- when it started and finished;
- whether it completed, timed out, was aborted, or failed;
- optional token usage; and
- which immutable artifacts it produced.

It does not claim that completion answered the research question. Statuses such as `blocked`,
`candidate-ready`, confidence scores, evidence sufficiency, and promotion decisions are versioned
interpretations owned by campaign code. The same immutable attempt may be interpreted repeatedly by
new code or another model without rerunning the harness.

JSON Schema remains appropriate for stable deployment boundaries such as agent environments, harness
profiles, secret references, and resource limits. Consuming projects may use schemas for their own
current domain objects, but those schemas are not part of the generic campaign contract.

## Relationship to existing attempts

The existing `lm env ... --attempt-once` machinery remains the execution engine for bounded OMP,
Codex, and Pi sessions. It supplies timeout handling, steering, raw event capture, usage, and
ledgers. `src/campaign_omp.ts` adapts `omp-rpc` directly to a campaign `AttemptWorkspace`. It:

1. accepts an already resolved environment and campaign-selected identity;
2. stages arbitrary native OMP profile files into an isolated guest directory;
3. supplies the prompt and optional model/environment overlay programmatically;
4. invokes the existing attempt harness;
5. writes its native session, mutated `PI_CODING_AGENT_DIR` state, events, stderr, prompt, profile,
   and run records into the attempt artifact tree; and
6. returns only the operational termination and usage envelope.

The consuming program remains responsible for putting environment, OMP, route, prompt-builder, and
target revisions in `identity.inputs`; the adapter never guesses which values define research
identity. A declarative environment may omit `modelDeployment` when its `omp-rpc` profile uses
remote inference rather than a local llama deployment.

OMP-native behavior remains OMP's responsibility. Campaign programs select declarative profiles;
lm-tools does not reproduce OMP tools, subagents, memory, or research policy.

For campaigns using the lm-tools free router, `src/free_router_omp.ts` can materialize the public
lane as an OMP `models.yml` provider and produce a credential-free route identity for the attempt
fingerprint. A campaign that should not depend on a standing router service starts its own with
`startFreeRouterSession` from `src/free_router_session.ts`: the router lives exactly as long as the
campaign run, writes its config, audit, and receipts beneath the attempt artifacts, and is stopped
reliably on success, failure, or interruption. The consuming program still decides which artifacts
may cross that remote inference boundary and records that decision among its inputs. For a single
bounded task without a durable named attempt, `runOmpTask` in `src/omp_task.ts` composes the same
pieces (paid default-config OMP, or an own free-router session with fail-closed admission) behind
one operational envelope.

## Recovery boundary

A completed or failed record is durable and reused. A `status.json` without a final record indicates
that the orchestrator stopped mid-effect. The current kernel fails explicitly and requires recovery;
it does not guess whether an external harness is still alive or silently rerun a dirty workspace.
Resume and retry policy should be added only with the harness adapter that can inspect the relevant
native session and environment.
