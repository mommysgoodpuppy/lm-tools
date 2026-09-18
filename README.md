# lm-tools

A Deno toolkit for running local language models and the systems around them. Concrete model
deployments, agent environments, project-specific campaigns, and machine service definitions are
intentionally owned by separate projects.

## Commands

```text
lm benchmark   replay a captured request and collect timing/VRAM measurements
lm deploy      validate and run a model deployment
lm download    download large artifacts with resume and integrity checks
lm env         manage an isolated declarative agent environment
lm free-router serve an explicitly zero-priced remote inference pool through OMP
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
declare model artifacts with size and SHA-256 checks, llama.cpp runtime options, compatibility
proxies, generated client configuration, auxiliary processes, and optional pinned vendor artifacts.

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
bounded turn-loop workers or persistent service workers.

```bash
deno run -A main.ts env project/environment.json --check
deno run -A main.ts env project/environment.json --dry-run
deno run -A main.ts env project/environment.json --apply
deno run -A main.ts env project/environment.json --refresh
deno run -A main.ts env project/environment.json --status
```

Secrets should remain ignored by the consuming project. Secret inputs must be mode `0600`, ignored
by Git, declared separately from ordinary seeds, and targeted outside the guest workspace.

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
