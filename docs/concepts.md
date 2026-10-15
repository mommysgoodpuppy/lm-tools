# lm-tools concepts

The layers of lm-tools, from raw inference up to agency (campaigns and claws). Each layer owns
exactly one kind of decision; ownership boundaries matter more than the implementation details of
any single adapter.

## Layer stack

```text
campaign      bounded tasks, attempts, durable state       (consuming projects)
claw          unbounded standing agents                    (consuming projects)
   ↑
harness       what turns inference into an agent session
   ↑
inference     deploy / proxy / free-router / omp gateway   (models and routing)
   ↑
model         llama.cpp runtimes, checkpoints, VRAM        (deploy, benchmark)
```

## Model and inference

The lowest layers. `deploy` runs a declarative model deployment (llama.cpp options, compatibility
proxies, generated client configuration). `proxy` normalizes OpenAI-compatible traffic. The free
router serves an explicitly zero-priced remote pool with cooldowns, failover, and the T3 observer
frontend. These layers never know about agents, tasks, or sessions: they move tokens.

## Harness

A **harness** is a pinned, declaratively configured adapter between lm-tools and an agent runtime.
It is the layer that turns inference into an ongoing agent session — coding agents (OMP, Codex, Pi)
and standing persona agents (Hermes) are both harnesses. Harnesses come in two lifecycle classes:

- **Attempt harness** (`harness.kind: "attemptHarness"`): bounded turn-loop executions. Adapters
  today: `omp-rpc` (OMP RPC mode over stdio JSONL, protocol v2 aware), `app-server` (Codex),
  `pi-rpc` (legacy Pi), and `exec-json` (Codex exec JSON). The declared harness materializes an
  invocation, runs one attempt inside a timeout envelope, captures raw events, normalizes a small
  lifecycle envelope (status, token usage, final result, compactions, timeout), and records
  everything durably.
- **Service harness** (`harness.kind: "serviceHarness"`): persistent supervised runtimes with a
  ready probe, restart policy, secrets boundary, and exposure (for example the Hermes gateway
  serving Discord).

An attempt harness owns how work happens inside a session: tools, subagents, memory, approvals, and
its own native event/session records. lm-tools owns lifecycle supervision, the normalized envelope,
and the audit projection. The adapter registry is deliberately small: materialize, spawn, stream
events, steer, abort, parse usage and result. lm-tools never grows harness-internal features to make
one harness resemble another.

The task/campaign layer accepts only harnesses declaring the attempt contract; standing agents use
the service contract. The same harness profile may run against different environment profiles as
distinct, replayable attempts.

## Environment

An agent environment (`schemas/agent-environment.schema.json`) declares where a harness runs: an
Incus backend or another isolation backend, guest identity, packages, network, writable/read-only
mounts, seeds, secrets boundary, and model access. The environment never knows what the agent is
asked; it only provisions and supervises the runtime substrate.

## Campaign and claw

The top layer splits by **bounded versus unbounded agency**:

- **Campaign** — bounded, programmatic agency. A consuming project writes trusted code that chooses
  questions, harness and environment profiles, concurrency, interpretation, and follow-up work.
  Named attempt effects preserve their selected inputs, operational outcome, and arbitrary hashed
  artifacts. lm-tools does not define a universal task, research-result, scoring, or completion
  schema. Interpretations can evolve and be recomputed from immutable attempt artifacts. See
  [`campaigns.md`](campaigns.md).
- **Claw** — unbounded. A standing agent that keeps working: open-ended conversations,
  self-scheduled work (cron), persistent identity, memory, and workspace. A claw is declared with
  `schemas/claw.schema.json` and managed by `lm claw CONFIG ...`; it composes inference (a model
  deployment, a free-router configuration, or both), a **service harness** (supervised ready probe,
  restart policy, exposure), and an isolation environment, plus an optional declared audit journal.
  Escape Velocity Shellie (the Hermes gateway deployment) is the reference claw. A one-shot bounded
  question put to a claw's runtime is campaign material only when declared and recorded as an
  attempt; the standing process itself never is.

The two share infrastructure but not state: a claw's memory/workspace belongs to the claw; a
campaign's generic durable state is its named operational attempts and artifacts. Project-owned code
decides which derived interpretations or promoted results to retain. Attempt harnesses serve
campaigns; service harnesses serve claws.

## Observability and audit

Every attempt and service inference is captured twice:

1. **Raw harness-native records** — OMP RPC frames, Codex app-server items, Hermes SQLite
   conversations. These are evidence, preserved as-is.
2. **Normalized envelope + audit journal** — the small lifecycle result plus request/response
   records in the append-only observer journal, projected by the T3 frontend. Each harness
   contributes an audit adapter that emits journal records; the frontend itself is harness-agnostic.

## Naming rules

- `harness` — the concept. An environment declares one `harness` with an `adapter` id and a `kind`
  of `attemptHarness` or `serviceHarness`.
- `attempt` — one bounded execution of an attempt harness. CLI: `lm env ... --attempt-once`,
  `--attempt-loop`, `--attempt-metrics`, `--attempt-dashboard`.
- `campaign` — a bounded program using durable named attempt effects.
- `claw` — unbounded agency: a standing agent on a service harness (e.g. Shellie).
- Stored identifiers such as the `lm_tools_worker` metric name predate this vocabulary and are kept
  for ledger continuity; they are not concepts.
