# Promote shared inference platform services out of claw manifests

Status: open, not scheduled Created: 2026-09-18 Scope: lm-tools, consuming projects
(escape-velocity-shellie, future lm-project)

## Problem

The inference _platform_ — the host services that hold provider credentials and serve model access
to anything on the machine — is currently declared inside individual claw manifests.
`escape-velocity-shellie/claw.json` lists these in its `environment.hostServices`:

- `escape-velocity-shellie-omp-broker.service` — OMP auth-broker; owns all remote provider
  credentials (OAuth, API keys, token refresh) in the host vault. The guest never sees a credential.
- `escape-velocity-shellie-omp-gateway.service` — OMP OpenAI-compatible auth-gateway; accepts
  provider-qualified model ids so clients hold only one bearer token.
- `escape-velocity-shellie-free-router.service` — the lm-tools zero-priced router (`free-auto` /
  `free-worker` lanes) in front of the gateway.
- `escape-velocity-shellie-observer.service` — the T3 audit frontend.
- `escape-velocity-shellie-inference.target` and the disabled `local-fallback` / `lm-qwen` units.

None of these is conceptually part of the Shellie claw. They are machine-level shared
infrastructure. Any second claw, and every campaign attempt (Incus research-task container pointing
`omp --mode rpc` at the gateway instead of enrolling credentials), will depend on services owned by
an unrelated manifest. That couples unrelated projects and breaks the ownership story:
refresh/restart semantics (`restartOnRefresh: false` on broker/gateway) are a platform decision
clawed into a consumer.

## Why it matters

- TASK-DEPLOYMENT.md (steamvr-tools) prescribes exactly this pattern for campaign attempts: "a
  deliberately exposed host authentication gateway, recording the mechanism without credentials.
  Narrow gateway access is preferable long term." The mechanism already runs; nothing declares it as
  infrastructure.
- A platform unit restart or port change should not require editing a claw manifest that does not
  own it.

## Proposed direction

1. lm-tools: define a **platform** declaration (manifest + `lm platform ...` command or a section of
   a machine-level config) that owns host units for inference substrate: credential broker, protocol
   gateway, router, observer, model services. Claw manifests stop declaring these in `hostServices`
   (claws keep only units that genuinely belong to the standing agent).
2. Claw and environment manifests gain a narrow _reference_ to the platform (e.g. gateway endpoint +
   protected token reference), validated at `--check`: reachable, token not in argv/logs.
3. Migrate escape-velocity-shellie: move broker/gateway/router/observer/target units out of
   `claw.json` into the platform declaration; the claw keeps the Hermes gateway unit and its
   exposure.
4. Campaign environments (later): the analysis-container recipe points at the platform gateway for
   model access; no credentials are deployed into guests. This fulfils the TASK-DEPLOYMENT.md
   auth-binding plan without new infrastructure.

## Constraints and cautions

- Keep the current state working until the platform declaration exists; do not break Shellie's live
  deployment mid-refactor.
- Systemd unit _names_ today embed the project name (`escape-velocity-shellie-omp-broker.service`).
  Renaming units is a visible change (user journal, `kill-everything`, PROVIDERS.md); prefer keeping
  `restartOnRefresh: false` semantics and doing the rename once, deliberately.
- The observer journal path is project-scoped today
  (`~/.local/share/lm-tools/escape-velocity-shellie/free-router/audit.jsonl`). If the
  router/observer become platform services, journal ownership and the per-project journal split need
  a decision (concepts.md: claws own their state; the journal is inference-audit, not claw state).
- lm-tools must stay machine-agnostic: the platform declaration belongs to a consuming project or
  machine config, not to lm-tools defaults (same rule as `config/base.json`).

## Current state (2026-09-18)

- Claw manifests and `lm claw` are implemented (`schemas/claw.schema.json`, `src/claw.ts`); Shellie
  is migrated and live.
- This issue is documentation only; no behavior changed.
