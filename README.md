# lm-tools

A Deno toolkit for running local language models and the systems around them. Concrete model
deployments, agent environments, project-specific campaigns, and machine service definitions are
intentionally owned by separate projects.

## Commands

```text
lm benchmark   replay a captured request and collect timing/VRAM measurements
lm claw        manage a declared unbounded standing agent (claw)
lm deploy      validate and run a model deployment
lm download    download large artifacts with resume and integrity checks
lm env         manage an isolated declarative agent environment
lm free-router serve an explicitly zero-priced remote inference pool through OMP
lm task        run one bounded OMP task with the free or paid profile
lm proxy       provide OpenAI-compatible request and stream normalization
lm vendor      materialize and verify pinned source builds
```

Run a command through the repository checkout:

```bash
deno run -A /path/to/lm-tools/main.ts --help
deno run -A /path/to/lm-tools/main.ts deploy /path/to/project/deployment.json --check
deno run -A /path/to/lm-tools/main.ts env /path/to/project/environment.json --dry-run
```

`deploy` and `env` require explicit configuration paths. This keeps the tool independent of any one
model, machine, network, or workload.

Free remote inference routing is kept behind an authentication-free access-adapter boundary. See
[`docs/free-router.md`](docs/free-router.md) for the ownership and streaming contract.

OMP is pinned as a source submodule at `vendor/omp` and supplies the initial account broker and
streaming access gateway. lm-tools does not implement provider login flows. After initializing
submodules, `deno task omp:check` verifies that the reviewed source and installed OMP executable
match `vendor/omp.version`.

## Base runtime configuration

The default [`config/base.json`](config/base.json) is deliberately conservative and contains no
machine service ownership. A consuming project can select its own validated base configuration:

```bash
LM_TOOLS_BASE_CONFIG=/path/to/project/base.json \
  deno run -A /path/to/lm-tools/main.ts deploy /path/to/project/deployment.json
```

The base file owns shared client reasoning-level mappings, GPU resource policy, emergency-stop user
units, and Tailscale Serve routes. Keeping that file with the concrete deployment prevents
machine-specific policy from leaking into this repository.

## Declarative deployments

Deployment files use [`schemas/deployment.schema.json`](schemas/deployment.schema.json). They can
declare model artifacts with size and SHA-256 checks, backend runtime options, compatibility
proxies, generated client configuration, auxiliary processes, and optional pinned vendor artifacts.

Backends are `llama.cpp`, `llama.cpp-diffusion` and `hipfire`. A `hipfire` deployment always runs
behind the Responses proxy. lm-tools owns its `home` (HIPFIRE_HOME): it links the model, DFlash
draft and vision sidecar into `home/models` (their file names must be the hipfire registry's for the
tag) and writes the catalog that aliases `model.id` to the tag. hipfire streams prompt progress
in-band, and the proxy renders it as the same prompt-evaluation reasoning llama.cpp deployments
show.

```bash
deno run -A main.ts deploy project/deployment.json --check
deno run -A main.ts deploy project/deployment.json --dry-run
deno run -A main.ts deploy project/deployment.json --fetch
deno run -A main.ts deploy project/deployment.json
```

## Agent environments

Environment files use
[`schemas/agent-environment.schema.json`](schemas/agent-environment.schema.json). The Incus backend
creates unprivileged workspaces, provisions pinned packages, copies declared seeds with filtered tar
streams, imports protected inputs without placing their values in argv, and can supervise either
bounded attempt harnesses or persistent service harnesses. Harness adapters are the
`harness.adapter` field of an environment: `omp-rpc`, `app-server` (Codex), `pi-rpc`, `exec-json`,
or a service runtime such as the Hermes gateway.

```bash
deno run -A main.ts env project/environment.json --check
deno run -A main.ts env project/environment.json --dry-run
deno run -A main.ts env project/environment.json --apply
deno run -A main.ts env project/environment.json --refresh
deno run -A main.ts env project/environment.json --status
```

Secrets should remain ignored by the consuming project. Secret inputs must be mode `0600`, ignored
by Git, declared separately from ordinary seeds, and targeted outside the guest workspace.

## Campaign programs

Campaigns are programmatic rather than manifest-defined. The API records durable, fingerprinted
attempt effects and arbitrary hashed artifacts while leaving questions, interpretations, scoring,
and follow-up policy to the consuming project. See [`docs/campaigns.md`](docs/campaigns.md).

## Tasks

`lm task` runs one bounded OMP task with a thin, stable contract: a prompt, a working directory, and
exactly one of two inference profiles. There is no research-result schema; the model's final text is
arbitrary and only operational facts (termination, usage, routes, artifacts) are recorded.

```bash
# Paid: normal OMP with the machine default paid model/config.
# The expected profile for code implementation and difficult bounded work.
lm task --profile paid --cwd /path/to/project \
  --prompt-file /tmp/prompt.md

# Free: zero-cost inference only. Starts a campaign-owned free-router session
# for exactly this task from an existing free-router config and fails closed
# if no lane is eligible. Intended for review, standing-claw style batch work,
# and mass tasks such as reverse engineering.
lm task --profile free --cwd /path/to/project \
  --router-config project/free-router.json \
  --prompt "Review this diff for correctness." \
  --json
```

Flags: `--profile free|paid` and `--cwd PATH` are required; `--router-config PATH` is required for
`free` and rejected for `paid`; the prompt comes from `--prompt TEXT`, `--prompt-file PATH`, or
stdin (at most one flag, never both); `--model ID` overrides the OMP model (free defaults to the
router lane); `--timeout-seconds N` bounds the process (default 3600); `--json` prints the
operational envelope instead of the final answer text, so Codex or scripts can parse it.

Both profiles supervise their OMP process with the hard timeout and external cancellation, and never
leave an orphaned process or router behind. Each task isolates its OMP session directory and
operational artifacts under `<cwd>/.lm-task/<id>/` (`events.jsonl`, `stderr.log`,
`task-result.json`, the OMP session, and for `free` a `router/` config/audit/receipt set). Paid
inference never routes through a free router; free inference never falls back to paid. Free-route
bearer credentials are only resolved through the configured OMP gateway and are never persisted or
printed.

Programmatic use — `runOmpTask` in `src/omp_task.ts` takes the same inputs as options and returns
the operational envelope, so campaign programs can fan out tasks without a CLI. Prerequisites: the
pinned `omp` executable (`deno task omp:check`), an OMP account enrolled for paid inference, and —
for the free profile — a free-router config whose lanes are eligible through the OMP gateway.

## Claws

A claw is an unbounded standing agent — open-ended conversations, self-scheduled work, persistent
identity, memory, and workspace. Claw manifests use
[`schemas/claw.schema.json`](schemas/claw.schema.json) and compose exactly three declared parts:
inference (a model deployment, a free-router configuration, or both), a service harness (for example
the Hermes gateway), and an isolation environment. An optional `observability` section declares the
append-only audit journal. See [`docs/concepts.md`](docs/concepts.md) for the campaign/claw split.

```bash
deno run -A main.ts claw project/claw.json --check
deno run -A main.ts claw project/claw.json --dry-run
deno run -A main.ts claw project/claw.json --apply
deno run -A main.ts claw project/claw.json --start
deno run -A main.ts claw project/claw.json --restart
deno run -A main.ts claw project/claw.json --stop
deno run -A main.ts claw project/claw.json --status
```

A claw's declared state — workspace, seeds, secrets, exposure — is preserved across refresh; only
declared control files are refreshed. Swap the `inference`, `harness`, and identity (secrets) parts
to deploy a different standing agent against the same manifest shape.

## Vendor builds

Vendor manifests use [`schemas/vendor.schema.json`](schemas/vendor.schema.json). They pin full
source revisions, apply ordered patches, run argv-based build steps, and verify named artifacts.
Checkouts and build outputs are runtime material and normally belong in the consuming project’s
ignored `vendor/` directory.

```bash
deno run -A main.ts vendor project/vendors/example.json --dry-run
deno run -A main.ts vendor project/vendors/example.json --check
deno run -A main.ts vendor project/vendors/example.json
```

## Diagnostics and verification

Proxy diagnostics and request captures can contain full local prompts and tool output. They are
written under ignored local paths by default and should not be published.

```bash
deno task verify
```

That runs formatting, lint, type checking, and the test suite.
