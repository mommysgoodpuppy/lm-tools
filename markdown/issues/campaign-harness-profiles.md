# Campaign attempt harness profiles

Status: open, next after the current claw work Created: 2026-09-18 Scope: lm-tools; consumers:
steamvr-tools TASK-DEPLOYMENT, future lm-project

## Problem

Campaign attempts (TASK-DEPLOYMENT.md) need a _declarative harness profile_ as the replayable unit:
`attempt = task manifest × harness profile × environment
profile × pinned revisions`. Today lm-tools
has the adapters (`omp-rpc`, `app-server`, `pi-rpc`, `exec-json`) as an inline `harness` block
inside an agent-environment manifest. That block:

- is not a referenced, shareable profile file;
- pins no adapter revision (the `vendor/omp.version` check is repo-wide, not per-attempt);
- does not materialize an isolated OMP profile directory, session directory, or per-attempt config
  snapshot;
- does not record `harness.profile` / `harness.revision` in attempt records, so a replay cannot
  prove it used the same profile.

## Proposed direction

1. `schemas/harness-profile.schema.json`: `adapter` id, `revision` pin reference (e.g.
   `vendor/omp.version`-style pin), native opaque invocation overlays, model/role bindings, approval
   policy, tool allowlist, timeouts. lm-tools validates cross-cutting fields (paths, secrets,
   limits, output locations) and treats adapter-native config as opaque.
2. Adapter registry in code: each adapter exports `materialize(profile,
   attempt)`, `spawn()`,
   `parse(events) → lifecycle envelope`. The four existing transports already share the skeleton;
   make the boundary explicit and per-adapter testable.
3. OMP materialization creates the isolated profile directory, session directory, task workspace,
   and exact argv per attempt, then snapshots the resolved non-secret configuration into the attempt
   bundle.
4. Attempt records gain `harness.profile` and `harness.revision`; `runAttemptOnce` verifies the
   adapter version against the pin before spawning and records the exact build (TASK-DEPLOYMENT
   requirement 1: "pin and report the OMP build").
5. Campaigns consume profiles by reference (consuming project owns the profile files and policy;
   lm-tools owns materialization and enforcement).

## Verification target

TASK-DEPLOYMENT.md "first vertical slice": one checked-in task manifest, one `omp-rpc` attempt in
the reusable analysis container with a materialized profile, preserved OMP records, schema-valid
result, and a replay without manual workspace repair. That slice also provides the first live
end-to-end check of the `omp-rpc` transport (its session-dir isolation has never run for real; unit
tests only so far).

## Related

- `markdown/issues/promote-inference-platform.md` — provider auth for attempts via the existing host
  OMP gateway rather than per-container enrollment.
- Host backend issue (if filed) — same profile system, different environment.
