# Qwen tinygrad self-optimization campaign

## Objective

Improve the pinned tinygrad Qwen3.8-27B `IQ4_XS` deployment on the RX 7900 XTX until it beats the
same model and quant in llama.cpp Vulkan. Keep the configured context at 102,400 tokens, peak
whole-device VRAM at or below 21,504 MiB, and the model output within the campaign's correctness
gates.

The exact full-workload baselines are:

| Backend                            |  Input | Output | Wall time |  Peak VRAM |
| ---------------------------------- | -----: | -----: | --------: | ---------: |
| llama.cpp Vulkan                   | 61,514 |    512 |  145.25 s | 18,645 MiB |
| tinygrad PR 17512 + local controls | 61,514 |    512 |  338.92 s | 20,943 MiB |

Tinygrad's decode rate is already close to the same-quant llama baseline (28 versus 30.25 tok/s).
Most of the 2.33x end-to-end gap is recurrent prefill: 192 versus 479.25 tok/s. Early campaign
scoring must therefore exercise real prefill rather than over-weighting short decode.

## Evaluation funnel

Do not replay the full 61K request for ordinary search candidates. Use the same captured coding
request at every HTTP tier, truncating only its role-message text and generation limit. This keeps
the prompt distribution stable while changing its cost.

| Tier    |  Input slice | Measured input | Output | tinygrad | llama Vulkan | When to run                          |
| ------- | -----------: | -------------: | -----: | -------: | -----------: | ------------------------------------ |
| Unit    |          n/a |            n/a |    n/a |  seconds |          n/a | Every edit, before loading the model |
| Screen  | 28,000 chars |   7,672 tokens |     32 |  24.57 s |      11.80 s | Every viable candidate               |
| Promote | 56,000 chars |  15,509 tokens |     32 |  52.39 s |      24.12 s | Candidate improves Screen            |
| Final   | full request |  61,514 tokens |    512 | 338.92 s |     145.25 s | Only promotion winners               |

The server takes about 56 seconds to load and warm up. Start it once per candidate and run all tiers
earned by that candidate in the same process. A normal candidate therefore costs about 81 seconds
including startup. A candidate that earns Promote costs about 133 seconds. Stop immediately on a
failed correctness, VRAM, or Screen gate.

The 28,000-character Screen tier is deliberately not smaller. A 14,000-character/3,793-token probe
took 11.72 seconds on tinygrad, but model startup still dominated total candidate time. Spending an
additional 13 seconds roughly doubles the prefill evidence and better exposes context-depth effects.

Run the fixed screen request with:

```bash
deno task lm benchmark \
  logs/requests/2026-08-20T16-59-29.768Z-fa2f16a3-c631-40b7-b7e2-d73702eef19d-01ee72b2.json \
  --api chat-completions \
  --url http://127.0.0.1:8000/v1/chat/completions \
  --max-input-chars 28000 \
  --expect-prompt-tokens 7672 \
  --max-output-tokens 32 \
  --vram-device /sys/class/drm/card1/device
```

Character slicing is a deterministic way to derive the probe from the immutable captured request;
the expected token count is also a gate. If tokenizer or chat-template changes alter 7,672, reject
the comparison rather than silently accepting a different workload.

## Promotion rules

An optimization attempt has three separate outcomes: invalid, valid but slower, or a candidate for
promotion. A speed number is accepted only after the relevant targeted tinygrad tests pass, the HTTP
request succeeds with exactly the expected input/output token counts, and peak VRAM remains within
the limit.

During broad search, one Screen run is enough to reject most changes. Require at least a 2% Screen
improvement before paying for Promote; this is comfortably larger than ordinary run noise. For a
promotion candidate, rerun Screen and Promote three times and compare medians against the frozen
tinygrad parent. Only then run Final. The actual finish line remains Final wall time below 145.25
seconds, not a microbenchmark or extrapolated token rate.

Keep prefill and decode metrics separate even though wall time is the primary score. A decode-only
change can be useful, but it should not displace work on the dominant prefill gap. Likewise, the
15.5K and Final tiers protect against an optimization that wins near the start of the context but
regresses as recurrent state depth grows.

## Runtime and containment boundary

The campaign has one trusted host controller and one disposable Incus worker environment. Keep GPU
ownership, evaluation policy, and canonical artifacts outside the environment that edits tinygrad:

```text
Host — trusted campaign controller
├── llama.cpp Vulkan worker-model service
├── immutable model artifacts, requests, baselines, and scoring rules
├── disposable candidate materialization and GPU evaluator
└── append-only campaign state and results

Incus container — disposable worker laboratory
├── agent harness and its configuration
├── editable tinygrad checkout
├── compiler, debugger, and CPU/unit-test dependencies
├── STATE.md and EVAL_REQUEST.json
└── no GPU device
```

The host is the authority for stopping and starting inference, deciding which tier a candidate has
earned, and accepting results. The worker can change source and request an experiment, but it cannot
change the model, quant, context, benchmark input, token-count gates, thresholds, or baselines.
Model artifacts remain on the host and do not need to be copied into the container.

The model proxy listens only on `10.248.172.1:1245`. On a host with UFW enabled, explicitly allow
TCP/1245 only on `incusbr-1000`, from `10.248.172.0/24` to `10.248.172.1`; host-local health checks
do not prove that this input rule exists. The live machine has this bounded rule installed.

The container intentionally has no GPU passthrough. This prevents an agent turn and an evaluation
from competing for VRAM and keeps GPU resets or faulty kernels out of the long-lived worker
environment. It can still run static checks, compiler tests that do not realize AMD programs, and
ordinary CPU unit tests. GPU correctness tests and profiling run only through the host evaluator.

Static inputs—the lm-tools controller source, pinned llama.cpp reference, Codex binary/config, and
phase prompts—are declared automatic-refresh seeds. The tinygrad candidate and campaign artifacts
are declared mutable seeds: `lm env ... --seed` can restore their host-declared baseline, while the
routine `--refresh` path deliberately preserves agent edits and evolving state. Evaluation results
are generated by the host controller and copied back through the declared guest result path. This
keeps the environment reproducible without bind mounts or silently overwriting experimental state
during control-plane refreshes.

The environment also declares the host-side worker, model proxy, dashboard, and T3 console as
managed user services. `lm env environments/qwen-tinygrad.json --apply` reconciles them on a clean
machine; `--refresh` relinks changed unit sources, reloads systemd, and restores their declared
enablement/running state. No transient `systemd-run` command is part of the reproducible setup. The
console unit builds the pinned T3 observer source before launch, so its served bundle is also a
derived artifact rather than undeclared host state. Observer services opt into restart-on-refresh so
code/UI changes take effect immediately. The model worker and bridge proxy explicitly do not,
preventing a control-plane refresh from interrupting an active campaign. The T3 unit also declares
its campaign-ledger directory and llama status endpoint; these are required for the observer SSE
route and must not be supplied as transient shell environment.

The campaign itself runs as the declared `lm-qwen-tinygrad-campaign.service`. Its native `--loop`
mode executes complete locked worker/evaluator cycles continuously, waiting 60 seconds after a
completed evaluation or 300 seconds after an orchestration failure. Stopping the controller restores
the Vulkan worker and bridge proxy through the unit's cleanup action.

Evaluator evidence is mirrored into the guest under the declared
`workspace.guestEvaluationArtifactsDirectory`. The Qwen campaign deliberately uses the same absolute
candidates path on both sides, so paths recorded in `EVALUATION.json` remain valid inside the
worker. This includes raw tinygrad stdout/stderr profiles, unit logs, and per-tier benchmark JSON.

After repairing campaign infrastructure or evidence, forcibly restart the affected in-progress
worker step with:

```bash
deno task lm campaign campaigns/qwen-tinygrad.json --restart-phase discovery
```

The command persists the restart request first, forcibly terminates the controller cgroup, and
enqueues a non-blocking restart of the declared service. The new controller consumes the request
exactly once and begins at the requested step. Systemd cleanup restores Vulkan if the interrupted
cycle happened to be evaluating.

The evaluator model declaration includes a metadata extraction command, host cache path, and guest
destination. Before each cycle, lm-tools regenerates the artifact only when its recorded source hash
does not match the declared GGUF hash, then mirrors it into the worker. The reduced JSON contains
architecture values plus tensor names, shapes, and quant types; tokenizer payloads, tensor data, and
weights are excluded. `--notify` can announce newly synchronized evidence to an active Codex turn
without restarting its phase.

At the end of a turn, lm-tools exports the worker's candidate into a fresh host evaluation checkout
based on the pinned tinygrad revision and accepted patch lineage. The export must preserve tracked
binary changes, modes, symlinks, and untracked source files, and it must have a content hash. Never
evaluate directly from the canonical vendor checkout. Record the immutable base revision, accepted
lineage, candidate content hash, dirty status, and evaluator version with every result.

## Worker model and finite-turn loop

Use the production llama.cpp Vulkan `UD-Q4_K_XL` deployment with MTP width two as the agent model.
The worker model and optimization target are deliberately different artifacts: the worker should use
the best practical local quality, while the initial target uses standard `IQ4_XS` because that is
tinygrad's accelerated path and permits an exact same-quant Vulkan comparison.

Do not keep a harness turn alive while evaluating. One campaign worker session is split into four
fresh Codex threads whose continuity lives in the repository and concise state files:

1. Ensure the Vulkan worker model is healthy and expose it only on the declared Incus bridge.
2. Run a 20-minute read-only discovery phase that must write `HYPOTHESIS.json` and update
   `STATE.md`.
3. Run an up-to-20-minute implementation phase constrained to that hypothesis.
4. Run a 10-minute verification-only phase, then a 5-minute handoff-only phase.
5. Snapshot the candidate only after the harness process has exited.
6. Stop Vulkan serving and verify that its process, listening ports, and VRAM residency are gone.
7. Materialize and evaluate the candidate on the host GPU.
8. Always stop the candidate, record the result, restore Vulkan, and wait for readiness.
9. Start a new turn with a compact summary of the result and retained campaign state.

There is therefore no suspended live Qwen request. "Sleeping the agent" means ending its current
turn while preserving work on disk, releasing the model service during evaluation, and starting a
fresh turn afterward. If a turn times out or crashes, its filesystem still exists, but no candidate
is evaluated until the controller has safely terminated the harness and captured a consistent
snapshot.

Tinygrad should not replace Vulkan as the worker backend merely because it first beats the
same-quant Vulkan baseline. Switching the agent service requires a separate deployment gate:

- quality equivalent to the current UD worker artifact, or support for that artifact;
- reliable 102,400-token operation across repeated real agent requests;
- better end-to-end agent-workload performance, including startup and prefill;
- clean shutdown, restart, and fault recovery.

## Agent-directed evaluation

Because the worker has no GPU, it communicates desired experiments through a declarative request
rather than arbitrary host commands. A request can select an allowed evaluator mode and narrow its
focus, for example:

```json
{
  "version": 1,
  "kind": "profile",
  "tier": "screen",
  "focus": "recurrent-prefill",
  "environment": {
    "DEBUG": "2"
  }
}
```

The controller validates this against the campaign policy, rejects changes to protected inputs, and
returns a standardized result bundle containing correctness, wall time, prompt/decode rates, peak
VRAM, relevant kernel or scheduler telemetry, logs, and the candidate identity. Requested diagnostic
environment variables and commands need an explicit allowlist. The evaluator should provide useful
default profiling on Screen so Qwen does not need an additional GPU cycle merely to learn where time
was spent.

For tinygrad `DEBUG=2` profiles, the evaluator parses kernel records after the server-ready marker,
aggregates count and GPU time by kernel family and exact kernel name, embeds the summary in
`EVALUATION.json`, and copies it back into the worker container. Raw host log paths remain available
for human investigation, but the next agent cycle does not need host filesystem access or another
model pass just to identify the dominant family.

`batched N` is explicitly recorded as an opaque captured graph containing `N` internal kernels, not
as a model kernel family. When graph replay owns the profile, a follow-up request may override the
allowlisted `JIT` value to `2`; this preserves captured replay without graph batching and makes the
individual program names visible to `DEBUG=2`.

An evaluation request is advisory. The controller still decides the actual tiers: Unit must pass,
Screen runs for every viable candidate, Promote requires the configured improvement, and Final is
reserved for validated promotion winners.

### Standalone AMD probes

A full Screen profile is unnecessarily expensive when the open question is local to an AMD-only
custom kernel. The worker may instead add a bounded Python program under the campaign-declared
candidate path prefix and request a configured runner:

```json
{
  "version": 1,
  "kind": "probe",
  "focus": "compare the generic and RDNA3 gated-delta outputs for fixed seeded inputs",
  "probe": {
    "runner": "python-amd",
    "path": "test/campaign/amd_probe.py"
  },
  "environment": {
    "DEBUG": "2",
    "JIT": "1"
  }
}
```

Probe runners are declarations in the campaign, not arbitrary host commands. The controller checks
the runner name, requires a normalized candidate-relative path under an allowlisted prefix, resolves
symlinks back inside the exported candidate, applies only allowlisted environment overrides, and
enforces the runner timeout. It stops Vulkan serving and waits for quiescent VRAM exactly as for a
normal evaluation, but runs only the probe: no model load, Unit suite, Screen request, or promotion.

Probe completion is not a scientific verdict. Its exit status says only whether the program executed
without a self-detected failure; a zero exit cannot establish that its assumptions, comparison, or
interpretation were sound. The result therefore records `executionSucceeded`, timeout status, wall
time, stdout/stderr artifact paths, and a parsed tinygrad kernel summary when `DEBUG=2` records
exist. All artifacts are mirrored into the worker at the same declared evidence path. A probe is
diagnostic and can never promote a candidate. The next cycle begins at discovery so the model can
inspect the probe source and evidence, notice contradictions, and decide what the observation means.

CPU probes remain useful for mathematical semantics and graph reachability. Their kernel names,
fusion, schedules, and timings must not be used as RDNA3 evidence because tinygrad dispatches both
quantized linears and gated-delta prefill to different custom implementations on AMD.

### Model-directed phase transitions

Discovery, implementation, and verification are states rather than a mandatory one-way sequence. At
the end of a successful phase the worker may write:

```json
{
  "version": 1,
  "next": "discovery",
  "reason": "the CPU surrogate was falsified; one AMD-only attribution question remains"
}
```

The controller validates `next` against the declared phase names, consumes the request once, and
starts that phase in a fresh harness thread. This permits repeating work or moving backward after a
valid falsification without keeping an exhausted context alive. With no request, declaration order
remains the default. The Qwen campaign uses an emergency ceiling of 64 transitions or 12 hours of
uninterrupted work before the controller forces its declared `handoff` phase. Normal probe and
evaluation requests should conclude the loop earlier. Exploration therefore remains bounded without
turning the ceiling into an ordinary implementation deadline, and always gets a separate opportunity
to preserve state and an evaluator request.

## Harness boundary

### Campaign vocabulary

Use three distinct levels when describing execution:

- A **cycle** starts with the worker model available, contains one or more phases, and ends when a
  candidate crosses the host-evaluation boundary or the worker fails. It is an experiment/candidate
  boundary, not a fixed time budget. The emergency wall and transition limits only cap a runaway
  cycle.
- A **phase** is one fresh, independently timed harness session such as discovery, implementation,
  verification, or handoff. Model-directed transitions may repeat a phase or move backward.
- A harness **turn** is one model inference/tool-interaction unit inside a phase. Compaction may let
  a session span multiple turns. These details belong in Live Stream, not the Campaign Map.

The Campaign Map therefore renders phases and host evaluations as its first-class timeline nodes,
using the cycle number only as lineage metadata.

Use a pinned Codex app-server build as the primary harness. Codex has the strongest demonstrated
long-horizon behavior of the harnesses already available here, and app-server exposes structured
turn, tool, usage, and compaction events without coupling the campaign controller to its terminal
UI. The source and local-provider fix are declared in `vendors/codex-local-compact.json`.

Codex 0.148.0 builds local compaction prompts without the active tool definitions. That changes the
prefix relative to normal turns, defeats prompt-cache reuse, and risks the compacted turn seeing a
different tool surface. The local patch carries the exact finalized `StepContext` into auto and
manual compaction and includes its model-visible tool specifications plus the normal parallel-tool
flag. It also injects the captured canonical developer/context prefix before the retained user
messages and summary. Without that second part, standalone compaction in Codex 0.148.0 rebuilds the
next Qwen request as `user, summary, developer, user`; Qwen's template correctly rejects the late
developer message. Treat these as required correctness and cost fixes, not inference optimizations.
Record every completed `contextCompaction` item in worker telemetry and test that a tool call still
works after a forced compaction with `deno task codex:smoke-compaction`.

A first open-ended baseline exposed a poor Qwen/Codex interaction: in 56 minutes Qwen generated
roughly 113K output tokens, issued 69 commands, crossed two automatic compactions, and produced no
new source edit or durable-state update. Codex's permissive reasoning/tool loop amplified Qwen's
tendency to reopen settled choices. Reasoning effort is therefore `low`, and lm-tools—not the
model—owns phase transitions.

Each phase gets a fresh ephemeral Codex thread, a narrow prompt, a cooperative wrap-up steer, and a
hard safety deadline. The phase must change its declared durable artifact; unchanged or missing
artifacts fail the worker session rather than silently progressing. Discovery may choose `implement`
or `profile`; the latter requests a useful host measurement rather than making a speculative edit.
Implementation cannot replace the chosen hypothesis merely because another idea appears.
Verification cannot invent a new optimization. Handoff cannot resume investigation.

The first bounded discovery test still spent 20 minutes and 50.9K output tokens on source tours and
manual performance arithmetic. It produced a useful profile hypothesis, but wrote `HYPOTHESIS.json`
in the final minute and was killed immediately before updating `STATE.md`. Discovery therefore
receives its wrap-up steer at minute 10, must write provisional versions of both artifacts together
before refinement, and must reuse a still-supported prior hypothesis. `python-numpy` is part of the
declared worker image; prompts require scripts for multi-step arithmetic and prohibit hand-built
numerical routines or detailed decompositions from too few mixed end-to-end samples.

Every campaign phase also declares a short forced-finalization allowance. If its work thread times
out or exits without changing every required artifact, lm-tools kills that thread and starts a fresh
Codex thread with no investigative mandate: it may only inspect the existing workspace, persist the
best current conclusion to the required files, and stop. This turns the cooperative wrap-up steer
into an optimization rather than the only defense against losing a nearly completed phase. A one-off
`--start-phase NAME` option resumes a cycle after an already completed phase without weakening the
normal phase order for future cycles.

### Turn research summaries

The harness's last assistant message is not the campaign's research record. It is often a transient
status update, especially when a phase times out. After the worker phases settle and before the
agent model is unloaded for GPU evaluation, lm-tools runs one bounded, tool-free Qwen request that
receives run facts, phase outcomes, repository snapshots, the durable state, and a filtered slice of
completed high-signal turn events. It produces a structured narrative with an outcome, retained
evidence, durable changes, and the best next step. The request is declared under `worker.turnSummary`
with its endpoint, model, reasoning effort, timeout, input budget, and output budget.

Summaries are appended to `summaries.json` beside the worker campaign ledger and attached to new run
records. They do not replace `STATE.md`, `HYPOTHESIS.json`, or `HANDOFF.md`; those remain the source
of truth for the next worker. Summary generation cannot fail a campaign turn: invalid JSON, model
unavailability, or timeout produces a deterministic fallback record with the error retained for
inspection. The Campaign Map joins summaries by run ID, which also permits accurate manual
backfills for older turns without rewriting historical campaign telemetry.

GPU handoff uses a 3,072 MiB quiescent ceiling. The measured desktop floor with Vulkan stopped and
all protected ports closed is roughly 2,350 MiB because the compositor and several desktop apps use
the same GPU; the earlier 2,048 MiB ceiling could never become true. The independent 21,504 MiB
whole-device peak gate remains unchanged.

This campaign deliberately disables semantic compaction. A bounded phase should finish before
compaction is useful, and fresh phase threads make the durable artifacts the explicit compression
boundary. Codex's fixed local compaction remains available and tested for other long-lived workers.

### Experimental model-directed semantic compaction

Threshold compaction remains the safety net, but it is not the only trigger. AutoCompact's central
result is that useful timing depends on task phase rather than context length: the model calls
`compact()` after a phase has produced a stable conclusion, and continuation quality depends on
three distinct behaviors—choosing the boundary, preserving sufficient state, and acting correctly
afterward. See [AutoCompact](https://autocompact.github.io/) for the training and evaluation setup.

The Codex adapter also supports an in-process app-server dynamic tool named `compact_context`; it is
not an MCP server. It remains available for experiments and other worker environments through:

```json
"compaction": {
  "mode": "model-directed",
  "maxPerSession": 4,
  "reminderTokens": 40000
}
```

Calling the tool means **compact and continue**, never **finish the work session**. In an
environment that enables it, the model supplies a reason and exact next action, then stops the
current app-server turn. lm-tools waits for that turn to settle, calls `thread/compact/start`, and
starts a continuation turn in the same thread. A normal assistant completion without the request
ends the work session. This lets one model-determined work session cross several app-server turns
and compactions while retaining the outer 45/60-minute limits.

When an enabled environment's most recent rendered request reaches 40K tokens, lm-tools sends one
queued reminder to checkpoint at the next coherent boundary. It does not demand immediate
compaction, and the reminder resets only after a compaction completes. Codex's 86K automatic
threshold remains the fallback if the model ignores the hint or never reaches a safe phase boundary.

Local Codex compaction uses a structured checkpoint prompt with objective and constraints, completed
phase, workspace state, established evidence, discarded hypotheses, verification status, remaining
risks, exact next action, and durable state locations. Canonical instructions and current world
state are prepended again by the patched harness. This approximates the public architecture of
OpenAI's native compaction—replacement context plus retained state and fresh instructions—without
pretending that plaintext can reproduce OpenAI's opaque learned compaction item. The official
[OpenAI compaction guide](https://developers.openai.com/api/docs/guides/compaction) describes the
server result as the canonical next context and notes that it may include retained items in addition
to the opaque compaction item.

The first evaluation should compare four policies from identical campaign snapshots: no semantic
trigger, threshold-only, prompted model-directed, and later judge-trained model-directed. Record
trigger position, checkpoint tokens, turns until the next compaction, repeated/reopened exploration,
continuation correctness, wall time, cache reads, and accepted optimization gain. A compaction that
saves tokens but causes repeated profiling or loses an established constraint is a regression.

Keep the harness behind a small adapter with behavior equivalent to:

```ts
interface AgentHarness {
  runSession(options: {
    endpoint: string;
    model: string;
    workspace: string;
    prompt: string;
    timeoutSeconds: number;
  }): AsyncIterable<AgentEvent>;
}
```

Keep a future compaction strategy boundary narrower than the whole harness adapter:

```text
Codex app-server loop
  └─ compaction policy
       ├─ codex-local-fixed (initial baseline)
       ├─ phase-aware manual compaction
       ├─ structured checkpoint plus compact
       └─ experimental Pi/AutoCompact-inspired policy
```

Pi RPC is the first alternative adapter. It is pinned declaratively by `vendors/pi-rpc.json`, runs
ephemerally with its state/config seeded by `environments/qwen-tinygrad-pi.json`, and has a separate
`campaigns/qwen-tinygrad-pi.json` so experiments cannot overwrite the Codex campaign journal or
candidate tree. Pi's native compactor keeps a structured summary plus recent messages; lm-tools
records completed `compaction_end` events and uses `get_session_stats` as the authoritative token
total. The same 45-minute cooperative wrap-up is sent through Pi's `steer` RPC command, followed by
the same 60-minute hard deadline.

Establish the fixed native Codex baseline first, then compare Pi from an identical source and state
snapshot. Later adapters for oh-my-pi, OpenCode, or a different compaction policy should reuse the
same campaign scheduling and scoring. Useful harness metrics are validated performance gain per
agent-hour, time to first accepted improvement, failed or no-action sessions, tokens consumed,
compactions, compaction cache ratio, and GPU evaluations consumed. Transcript style or the number of
edits is not a campaign result.

## GPU phase boundary and recovery

### Operator pause and resume

The campaign can release the GPU without discarding research state:

```bash
deno task lm campaign campaigns/qwen-tinygrad.json --pause
deno task lm campaign campaigns/qwen-tinygrad.json --resume
```

Pause immediately stops the controller cgroup, evaluator listener, and all campaign-declared worker
services, waits for quiescent GPU state, records `PAUSED` in the durable journal, and leaves the
monitoring console online. Guest source edits, state files, evaluation artifacts, and campaign
history remain intact. Resume clears the paused state and starts the controller; work continues in a
fresh discovery phase so an interrupted inference is never treated as completed. Repeated pause and
resume requests are safe. A persistent pause marker is also a systemd start condition for the
controller, Vulkan agent, and bridge proxy. It survives shutdown and reboot, so a paused machine
does not briefly reload the model during login; only `--resume` removes the marker.

The local Qwen worker and candidate runtime share one GPU and cannot run simultaneously. The host
controller must own an exclusive lock and journal every transition through this state machine:

```text
WORKER_READY
→ WORKER_RUNNING
→ CANDIDATE_EXPORTED
→ VULKAN_STOPPING
→ GPU_QUIESCENT
→ EVALUATING
→ RESULT_RECORDED
→ VULKAN_STARTING
→ WORKER_READY
```

GPU quiescence requires more than sending `SIGTERM`: wait for the service process to exit, its ports
to close, and dedicated VRAM use to fall below a configured threshold. Candidate cleanup and Vulkan
restoration belong in a `finally` path so benchmark, compiler, timeout, and GPU-fault failures all
restore the worker service.

On startup after a controller crash or reboot, reconcile observed processes, ports, VRAM, candidate
directories, and the last journaled phase before doing new work. Never assume that the phase written
before a crash completed. At most one worker turn or evaluator may hold the campaign lock, and a
partially written result is not eligible for promotion.

This resource transition belongs in the campaign controller, not in the worker prompt. The worker
should never be responsible for stopping its own model server or deciding that the GPU is safe to
reuse.
