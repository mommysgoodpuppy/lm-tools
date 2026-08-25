# lm-tools

A personal Deno toolbox for the small scripts that inevitably accumulate around serving local
language models. See [`docs/wtf.md`](docs/wtf.md) for the concrete compatibility, lifecycle, and
resource failures that make the integration layer necessary.

The CLI covers the full local-model lifecycle:

- schema-validated deployments spanning a model, inference backend, compatibility services, and
  generated client configuration;
- resumable, parallel downloads for large model files;
- a configurable `llama-server` launcher with the local Qwen setup as its current default;
- the OpenAI compatibility proxy needed by clients such as VS Code;
- an experimental native-AMD runner backed by a pinned vendored tinygrad snapshot.

The proxy normalizes empty function schemas and turns llama-server's raw reasoning stream into the
complete reasoning-summary event lifecycle expected by VS Code, including synthesized part and
completion events that llama-server does not emit itself. In combined VS Code mode it also parses
llama.cpp's real prompt-evaluation progress and shows it as a local-only reasoning trace while the
model is ingesting the request. Unsupported Responses API continuation IDs are removed defensively;
the VS Code model is also configured with `zeroDataRetentionEnabled`. That makes VS Code serialize
its locally available messages instead of slicing them at a server-side response marker; after VS
Code compacts a long conversation, this means the latest compaction summary and subsequent turns,
not the raw pre-compaction transcript.

Runtime diagnostics are appended to the ignored `logs/lm-tools.jsonl`. Entries include request
shape, compatibility rewrites, upstream status and errors, timings, and llama-server output. Every
non-empty request body is also captured verbatim under the ignored `logs/requests/` directory; the
corresponding JSONL request entry contains its absolute `requestCapture` path. This intentionally
records complete local prompts and tool outputs for exact replay and debugging, but never request
headers or authentication tokens. Set `LM_TOOLS_LOG` to override the log file path; request captures
are stored in a `requests` directory beside that file.

All proxy-generated reasoning uses the `lm-tools-system-reasoning-<kind>-…` item namespace. The
proxy removes those items—and any merged legacy prompt-progress prefix—from later inbound history,
so UI-only diagnostics can persist in VS Code without becoming model context.

Captured requests can be replayed through either API shape with comparable wall-time and VRAM
sampling. Chat Completions mode converts role-based Responses messages and function tools, while
rejecting unsupported input item types instead of silently changing the prompt:

```bash
deno task lm benchmark logs/requests/example.json \
  --api chat-completions \
  --url http://127.0.0.1:8000/v1/chat/completions \
  --max-output-tokens 512 \
  --vram-device /sys/class/drm/card1/device \
  --output results/tinygrad-long.json
```

`--max-input-chars N` derives deterministic shorter probes from a captured role-message request.
This is useful for multi-fidelity optimization campaigns; retain the endpoint's reported prompt
token count as a workload-integrity gate. The calibrated Qwen tinygrad funnel and same-quant Vulkan
finish line are documented in [`docs/qwen-tinygrad-campaign.md`](docs/qwen-tinygrad-campaign.md).
The Codex worker runs four fresh, artifact-gated phases—20-minute discovery, up-to-20-minute
implementation, 10-minute verification, and 5-minute handoff—at low reasoning effort. Discovery may
request a host profile instead of guessing and has the exact llama.cpp Vulkan baseline source as a
reference checkout.

## Declarative deployments

[`deployments/qwen-vscode.json`](deployments/qwen-vscode.json) is the canonical deployment for this
machine. It declares the model and its capabilities, context/output limits, backend kind and tuning,
the Responses compatibility proxy, and the VS Code provider generated from those values. The file
references [`schemas/deployment.schema.json`](schemas/deployment.schema.json), so editors and
`lm deploy` use the same contract. Deployments may also publish their selected HTTP endpoint through
Tailscale Serve while retaining a loopback-only backend; `lm deploy` installs the mapping on startup
and removes it on shutdown. Each deployment also writes portable client snippets to the gitignored
`api-jsons/<model-id>/` directory, including `vscode.json` and Pi's `pi.json`; Tailscale-enabled
snippets use the machine's MagicDNS HTTPS URL. The inherited [`config/base.json`](config/base.json)
defines the machine-wide GPU policy: exclusive ownership, conflicting executables, bounded shutdown,
and minimum VRAM that must remain free. Each model declares its expected residency through
`runtime.expectedVramMiB`. Exclusive deployments hold a runtime lease, evict stale conflicts, and
refuse to load unless expected model use plus the base safety reserve fits in currently free
dedicated VRAM. A deployment should override the base with `resources.gpu.mode: "shared"` only for
an intentionally optimized multi-model setup.

```bash
# Validate JSON Schema, model/executable paths, and every emitted llama.cpp long option.
deno task lm deploy --check

# Show the resolved process topology and generated VS Code provider without changing anything.
deno task lm deploy --dry-run

# Atomically reconcile chatLanguageModels.json without starting the backend.
deno task lm deploy --client-only

# Reconcile clients, start the selected backend, and start declared compatibility services.
deno task lm deploy

# Emergency stop: stop configured user units, inference processes, and Tailscale Serve mappings.
deno task kill-everything
```

The schema uses `backend.kind` as a discriminant. `llama.cpp` is the first implemented backend;
future vLLM or tinygrad deployment fields can be added as new schema/type variants without leaking
their arguments into model or client configuration. llama.cpp itself does not currently publish a
machine-readable CLI schema: its typed option registry is internal and its INI model presets cover
only llama-server. lm-tools therefore owns the stable typed subset and verifies its generated flags
against the installed binary's live `--help` output. Raw backend argument strings are deliberately
not part of the deployment format.

Model entries may also declare an immutable download source with an expected byte size and SHA-256.
`lm deploy CONFIG --fetch` uses the resumable downloader and refuses a changed or corrupt artifact.
Matched speculative draft models use the same pinned-source and integrity contract. Hugging Face
artifacts default to sixteen concurrent 64 MiB ranges instead of the generic eight; this saturated
the current connection at about 28.5 MB/s during the 16.81 GB DiffusionGemma fetch. Deployments can
declare auxiliary local processes with their executable, working directory, environment, and HTTP
readiness probe; lm-tools owns their lifecycle together with the backend and persists both stdout
and stderr in the normal diagnostic log.

Backends built from an unmerged PR or a local patch may declare a `vendor` reference naming a
tracked manifest and one of its output artifacts. Deployment checks then verify the checkout
revision, origin, declared patches, absence of unexpected source changes, and required artifact
before inspecting the executable.

## Declarative vendor builds

Files under [`vendors/`](vendors/) describe reproducible source builds independently of their model
deployment. A manifest can coordinate multiple Git repositories pinned by full commit SHA, apply
ordered tracked patches, run argv-based build steps in explicit working directories, and publish
named file, directory, or executable artifacts. Strings support `${root}`, `${manifest}`, and
`${checkout.NAME}` interpolation.

```bash
# Inspect without changing the workspace.
deno task lm vendor vendors/llama-dflash2.json --dry-run

# Materialize missing checkouts, apply patches, build, and verify outputs.
deno task lm vendor vendors/llama-dflash2.json

# Detect revision, origin, patch, source-tree, or artifact drift.
deno task lm vendor vendors/llama-dflash2.json --check
```

The Qwen tinygrad campaign uses the same mechanism for its pinned Codex harness. This build carries
the local-provider compaction tool-manifest fix and can be reproduced with:

```bash
deno task codex:vendor
deno task codex:smoke-compaction
deno task codex:smoke-semantic-compaction
```

The semantic smoke gives Qwen a direct app-server `compact_context` tool, verifies that lm-tools
turns the model request into native Codex compaction, and checks that the same work session resumes
and can still use tools. No MCP server is involved.

The optional Pi RPC harness is pinned and packaged independently. Its smoke test exercises a real
Qwen tool call through the no-GPU worker container and reports Pi's authoritative token totals:

```bash
deno task pi:vendor
deno task lm env environments/qwen-tinygrad-pi.json --apply
deno task pi:smoke-rpc
```

The current manifests cover the tinygrad RDNA3 Qwen PR, an isolated candidate for the experimental
tinygrad RDNA3 compiler-backend PR, the DFlash 2 llama.cpp fork, and the two-checkout DiffusionGemma
frontend/runner build. Manifests are trusted local code because their build steps execute commands;
review changes to them just as carefully as a shell script.

## Disposable agent environments

[`environments/ps2-linux.json`](environments/ps2-linux.json) declares the Incus workspace used for
the PS2 Linux/PCSX2 agent. It keeps inference on the host GPU while running Codex, builds, and PCSX2
inside an unprivileged container. Source entries are copied with filtered tar streams; they are
never host bind mounts. The guest receives no Incus/Docker socket, GPU, physical NIC, host account
credentials, SSH keys, or API keys.

The current environment has 12 CPUs, 24 GiB RAM, a 120 GiB loop-backed Btrfs pool, and a private
Incus NIC. UFW allows DHCP, DNS, public internet, and the Qwen bridge listener, while denying routed
access to LAN, link-local, and Tailscale/private IPv4 ranges. PCSX2 therefore uses the container NIC
instead of the host's physical adapter. Incus still shares the host kernel; this is a strong
boundary for an accident-prone local coding agent, not a hardware-VM boundary against a deliberate
kernel exploit.

Host initialization is intentionally separate because it needs administrator approval. The reviewed
inputs are [`environments/incus-host-preseed.yaml`](environments/incus-host-preseed.yaml) and
[`scripts/configure_ps2_agent_ufw.sh`](scripts/configure_ps2_agent_ufw.sh). After Incus is
initialized and the user has a fresh login with the confined `incus` group, the normal lifecycle is:

```bash
# Validate paths and schema, then inspect every container/copy command.
deno task lm env --check
deno task lm env --dry-run

# On first creation this also installs declared guest packages and copies filtered sources.
deno task lm env --apply

# Re-run package provisioning explicitly. A full seed is intended for a fresh
# or deliberately reset workspace and can overwrite copied source paths.
deno task lm env --provision
deno task lm env --seed

# Safely refresh only declared control files (Codex config and worker prompts).
# This does not overwrite the guest's working repository copies.
deno task lm env --refresh

deno task lm env --status
deno task lm env --exec -- bash
```

Start the model and its bridge-only compatibility listener in two host terminals:

```bash
deno task lm deploy deployments/qwen-vscode.json
deno task lm env --model-proxy
```

The seeded [`environments/ps2-linux-codex/config.toml`](environments/ps2-linux-codex/config.toml)
points guest Codex at `http://10.248.172.1:1235/v1`. Custom providers do not require a Codex login
when no authentication variable or OpenAI-auth requirement is configured. Codex runs with approvals
and its internal sandbox disabled because Incus is the outer sandbox. The compatibility proxy folds
Codex's leading developer messages into the initial system instructions for Qwen's stricter chat
template and retains the existing Responses reasoning/tool adaptations.

The autonomous worker uses a plaintext, provider-neutral handoff in
[`environments/ps2-linux-worker/HANDOFF.md`](environments/ps2-linux-worker/HANDOFF.md) and a short
fresh-turn prompt in
[`environments/ps2-linux-worker/TURN.md`](environments/ps2-linux-worker/TURN.md). Each turn is a new
ephemeral Codex session; continuity lives in the copied guest `STATE.md`, not an ever-growing or
provider-specific transcript. Run one inspected turn before enabling the loop:

```bash
deno task lm env --worker-once
deno task lm env --worker-loop
deno task lm env --worker-metrics
deno task lm env --worker-dashboard  # JSON observer API on http://127.0.0.1:49388
```

Every turn has a two-hour hard limit and produces an append-only Codex JSONL event log, a per-run
JSON report, and a cumulative `campaign.json` under `logs/agent-campaigns/ps2-linux/`. Reports track
wall time, exit/timeout status, input/cached-input/output tokens, before/after Git heads and status,
the worker-state hash, and the final agent summary. These fields make campaign totals auditable and
allow later human classification of real progress; token consumption alone is not called progress.
The localhost observer exposes campaign totals, the active turn and objective, service health, JSONL
freshness, recent reasoning, and command output tails at `/api/status`. It intentionally has no HTML
frontend; it is a data source for the real console. Authoritative token counts appear when Codex
completes a turn. The external loop remains the campaign supervisor. Codex Goal mode is useful for
one long-lived interactive task, but is not required here because fresh sessions plus durable state
are more resilient to crashes, context growth, and provider changes.

The full console is a host-side, read-only viewer forked from T3 Code. Codex still owns the real
session, commands, and child processes inside Incus; lm-tools owns supervision and durable JSONL
events. Observer builds mount the lm-tools renderer directly instead of T3's router, authentication
bootstrap, websocket client, session manager, or terminal controls. Open `http://127.0.0.1:49389/`
directly; no pairing token or container-side T3 installation is involved, and rebuilding or
restarting the viewer cannot interrupt the worker.

The observer endpoint uses server-sent events and the UI renders a live conversation timeline.
Reasoning, assistant messages, plans, errors, and command lifecycle events have distinct treatments;
command start and completion are merged into one default-open card with its own output follow, and
scrolling away pauses automatic live-follow. Initial state is a compacted snapshot; appended JSONL
events are then batched at a 25 ms cadence, accumulated by Codex item ID, and followed without
animated scrolling. The console also samples llama.cpp's read-only `/slots` telemetry: its header
shows actual context occupancy against the backend's 131K limit, while uncached prompt evaluation is
rendered as a synthetic progress event during otherwise silent command-to-token gaps. Cached tokens
are reported separately, and the synthetic generation state yields to real streamed reasoning or
message deltas as soon as they arrive. The PS2 worker uses Codex app-server over its stdio JSONL
transport, and the observer understands the raw `item/*` lifecycle, agent/reasoning text deltas,
command-output deltas, plan updates, errors, and live token-usage notifications. The compatibility
`exec-json` transport remains available for simpler environments, but only reports aggregate command
output when a command completes. Neither transport requires pairing the viewer.

The MIT-licensed upstream source is vendored directly under `vendor/t3code/` and modified as normal
source instead of maintained as a growing patch stack. The original license notice remains in the
vendored tree. [`vendor/t3code.version`](vendor/t3code.version) records the upstream commit and
runtime tuple for provenance. Build it on the host with the pinned package-manager version:

```bash
deno task t3code:build
```

The viewer reads `logs/agent-campaigns/ps2-linux/` directly on the host and never needs a copy of
T3, its dependencies, or campaign events in the guest. Campaign-level time, cross-turn token totals,
state transitions, and progress classification remain lm-tools data. Closed-turn Codex usage is
authoritative; any live number must be labelled as inference-call usage or an estimate rather than
silently mixed with the final ledger.

The compatibility proxy records a `response_usage` diagnostic at every completed model inference,
keyed by Codex session, thread, and turn IDs from `client_metadata`. This supplies frequent live
inference-call accounting without waiting for a multi-hour agent turn to close. It remains separate
from the final `turn.completed` ledger because an in-flight generation has not reported its final
usage yet and because campaign totals must not double-count repeated full-context requests.

The reviewed user units live under `environments/systemd/`. Link them once, then start the campaign
target manually by default. It owns the model, bridge proxy, worker loop, observer API, and T3
console together; stopping the target stops every member through `PartOf=`. The worker unit enters
the declared `incus` group with `newgrp`, so it also works when the existing user manager predates
Incus group membership.

```bash
systemctl --user link "$PWD"/environments/systemd/*.{service,target}
deno task ps2-campaign start       # manual full-stack start
deno task ps2-campaign stop        # master off switch
deno task ps2-campaign status

# Auto-start is explicit and optional; manual control remains available either way.
deno task ps2-campaign autostart-on
deno task ps2-campaign autostart-off
```

Stopping the worker alone is an immediate interruption: container files and the partial raw event
log survive, but the in-flight turn does not produce a completed campaign report. Start it again to
begin a fresh turn from durable state. A cooperative "pause after current turn" remains future work.

```bash
deno task ps2-campaign pause-now
deno task ps2-campaign resume
```

The end-to-end smoke test on 2026-08-18 verified all of the following from inside the guest:

- public HTTPS worked while a private-LAN address was blocked;
- the copied PCSX2 binary had no missing libraries and booted the copied custom Linux kernel through
  `Linux version 5.4.221-pcsx2-instrumented+` to `Run /init as init process` under Xvfb/software GL;
- guest Codex reached host-side Qwen without a login or key, used shell tools to inspect the runbook
  and the separate PCSX2 checkout, then created and verified one guest-only report;
- the corresponding host repository was unchanged.

The GPU measured about 75 W with Qwen loaded and idle and about 302 W during generation. For a
whole-machine reading, use a wall meter; monthly energy cost is
`average wall watts × 0.72 × price per kWh`.

## Talkie web deployment

[`deployments/talkie-web.json`](deployments/talkie-web.json) reconstructs the old Talkie setup as a
single deployment: current system llama.cpp on port 8187 plus the existing Talkie web UI on port
5177. The UI is explicitly placed in external-backend mode, so it cannot start its old bundled llama
runtime.

The selected model is the newer
[`talkie-1930-13b-it-vulkan-fixed` Q5_K_M](https://huggingface.co/zakarth/talkie-1930-13b-it-vulkan-fixed-GGUF).
It uses the canonical upstream Talkie GGUF layout and fixes the two activation channels that can
overflow fp16 intermediates on Vulkan. The original `sol-wy` Q5 file and custom ROCm llama checkout
remain untouched as historical fallbacks, but are not part of the primary deployment.

```bash
# Download about 9.86 GB, resume interrupted transfers, and verify SHA-256.
deno task lm deploy deployments/talkie-web.json --fetch

# Inspect the exact backend and web process without starting either one.
deno task lm deploy deployments/talkie-web.json --dry-run

# Start both; then open http://127.0.0.1:5177.
deno task lm deploy deployments/talkie-web.json
```

## DiffusionGemma Lab on AMD Vulkan

[`deployments/diffusiongemma-lab.json`](deployments/diffusiongemma-lab.json) pins the complete niche
runtime tuple: the DiffusionGemma Q4_K_M GGUF, the open llama.cpp DiffusionGemma PR commit, the Lab
frontend commit, and `Vulkan0` on the RX 7900 XTX. The deployment schema represents this as the
separate `llama.cpp-diffusion` backend kind; its device, GPU layers, flash attention, and automatic
VRAM-fit margin are typed fields rather than an opaque argument string.

The upstream Lab repository currently has no declared software license. lm-tools therefore does not
copy its frontend source into the tracked project. The reproducible bootstrap checks out its exact
commit into the ignored `vendor/` tree, installs its locked npm dependencies, applies its own visual
viewport patch to the pinned llama.cpp PR, and builds `llama-diffusion-cli` with Vulkan:

```bash
deno task diffusiongemma:vendor

# Download and integrity-check the 16.81 GB Q4_K_M artifact.
deno task lm deploy deployments/diffusiongemma-lab.json --fetch

deno task lm deploy deployments/diffusiongemma-lab.json --dry-run
deno task lm deploy deployments/diffusiongemma-lab.json
```

The UI is then available at `http://127.0.0.1:49387`. It owns the interactive diffusion CLI so it
can recover complete denoising frames, replay them, and render settle-order heatmaps. lm-tools owns
the outer process group and persistent logs, ensuring the UI and any CLI child are terminated
together. The Q4 model should fit on the 24 GB card, but it cannot coexist with the 27B Qwen
deployment in VRAM; stop Qwen before loading DiffusionGemma.

## Use

```bash
deno task lm --help
deno task lm deploy --check
deno task lm download URL ./model.gguf
deno task lm llama --context 64k
deno task lm proxy
deno task lm vscode
deno task lm tinygrad --max_context 128 --benchmark 5
```

The launcher defaults to `127.0.0.1:8080`. The proxy defaults to `0.0.0.0:1235` and forwards to that
llama server, so a VS Code-compatible base URL is:

```text
http://<this-computer>:1235/v1
```

The proxy has no authentication. Keep port 1235 on a trusted network or change the listen host:

```bash
deno task lm proxy --listen-host 127.0.0.1
```

For VS Code on this machine, the canonical deployment starts Unsloth's Qwen3.8-27B `UD-Q4_K_XL` at
100K with the measured K=q8_0/V=q4_0 cache balance and native MTP drafting at `n-max=2`, waits for
llama-server to become healthy, and then starts a localhost-only proxy:

```bash
deno task lm deploy deployments/qwen-vscode.json --fetch
deno task lm deploy deployments/qwen-vscode.json
```

An experimental deployment uses the official Q4_K_M DFlash 2 drafter at width four. Its
implementation is pinned from the still-unmerged llama.cpp PR rather than replacing the system
binary:

```bash
deno task dflash2:vendor
deno task lm deploy deployments/qwen-vscode-dflash2.json --fetch
deno task lm deploy deployments/qwen-vscode-dflash2.json
```

DFlash 2 is lossless speculative decoding: it changes decode speed, not the target model's output
distribution. On the captured long agent request it did not beat MTP on this GPU, so it remains an
explicit experiment rather than the default. See
[`docs/qwen38-quant-dflash2.md`](docs/qwen38-quant-dflash2.md) for the quant decision, hardware
constraints, reproducible artifacts, and measurements.

The older standalone `lm vscode` command still supports `--mtp 0` to disable MTP or another integer
to benchmark a different draft width. Against a captured 17,907-token VS Code agent request on the
RX 7900 XTX, baseline decode was 36.69 tok/s; MTP widths 1, 2, and 3 reached 53.04, 58.34, and 57.83
tok/s respectively. A confidence-gated `n-max=16`, `p-min=0.8` configuration reached only 42.45
tok/s on this reasoning-heavy workload.

This Qwen generation uses hybrid DeltaNet/recurrent layers. On the RX 7900 XTX, llama.cpp's Vulkan
backend is required for practical prompt processing: the b10355 Vulkan build processed a 20K-token
128K-context probe at about 621 tokens/s, while the ROCm/HIP backend collapsed at context depth.

## Experimental tinygrad backend

The tinygrad checkout is intentionally ignored rather than stored directly or added as a submodule.
[`vendors/tinygrad-rdna3-qwen.json`](vendors/tinygrad-rdna3-qwen.json) pins PR 17512's exact head
and applies the tracked compatibility/runtime-control patch. The PR adds RDNA3 kernels for
IQ4_XS/Q5_K/Q6_K weights, quantized KV attention, Gated DeltaNet prefill, and decode. The local
patch adds the Q3_K and IQ4_NL decoding needed by Unsloth's mixed artifacts and fixes graph handling
of captured static weight slots. Bootstrap it after cloning lm-tools:

```bash
deno task tinygrad:vendor
```

The runner uses tinygrad's native `AMD` backend directly—ROCm Python packages are not required:

```bash
# Defaults to the non-dynamic Qwen3.8-27B IQ4_XS, matching tiny corp's fast path.
deno task lm tinygrad --max_context 4096 --benchmark 5

# Exercise chunked recurrent prefill; upstream currently forces a chunk size of one.
deno task lm tinygrad --recurrent-chunk 16 --max_context 4096 --serve 8000
```

The earlier upstream baseline ran Qwen3.8-27B correctly but reached only about 1.9 decode tok/s and
11 prefill tok/s. Those numbers do not describe the pinned RDNA3 PR; its measured results and the
exact model/context settings live in the Qwen design record below.

The local static-slot patch keeps the fast batched `JIT=1` path usable; `--jit 2` remains available
as a diagnostic unbatched mode. Do not enable `JITBEAM` on this machine for now: searching 27B
kernels hit an AMD queue timeout and caused a hard reset. The recurrent chunk override is opt-in and
retains tinygrad's upstream chunk-size-one default.

The selected tinygrad artifact is the archived, non-dynamic Qwen3.8-27B `IQ4_XS` (SHA-256
`9fd40d7036f5e0918e20aaeebf11468fafd06bb53d4d980eef6bb7e4e4ace666`). It matches the tensor formats
accelerated by PR 17512. At 102,400 configured context it measured 44.3--44.7 decode tok/s on a
shallow benchmark. Replaying a captured 61,514-token coding request measured 192 prefill tok/s, 28
decode tok/s, 338.92 seconds server-side, and 20,943 MiB peak whole-device VRAM. The Unsloth
Dynamic-v3 `UD-IQ4_XS` can run with the local format fixes, but its mixed tensor formats fall back
to generic kernels and reached only 2.6--3.7 decode tok/s; it is therefore not a tinygrad deployment
candidate.

[`vendors/tinygrad-rdna3-backend.json`](vendors/tinygrad-rdna3-backend.json) separately pins PR
16668's experimental RDNA3 compiler backend. It is intentionally not combined with the working Qwen
checkout. The backend passed all 21 applicable `test/test_tiny.py` smoke tests on this 7900 XTX,
despite an upstream Strix Halo crash report. However, transplanting PR 17512's Qwen kernel modules
gave five compile-time failures out of six tests under `DEV=AMD:RDNA3`; the normal `DEV=AMD`
renderer passed all six. Combining the PRs therefore requires new RDNA3 instruction
selection/register lowering, not merely resolving their two textual merge conflicts.

To make `lm` available globally:

```bash
deno install --global -A --name lm main.ts
```

## Llama examples

```bash
# Current local Qwen default, 64K context and q8_0 KV cache
deno task lm llama

# Another GGUF, mixed KV cache, and extra raw llama.cpp options
deno task lm llama /models/model.gguf --context 128k --kv-k q8_0 --kv-v q4_0 -- --verbose

# Inspect the exact command without starting the server
deno task lm llama --dry-run
```

Environment overrides retained from `lm-download` are `MODEL_PATH`, `LLAMA_SERVER`, `PORT`,
`CONTEXT_SIZE`, `KV_CACHE_TYPE`, `KV_CACHE_TYPE_K`, and `KV_CACHE_TYPE_V`.

## Development

```bash
deno task verify
```

## Migration notes

This starts the migration without pretending the experimental pieces are stable interfaces:

- `parallel_download.py` is now the `download` command and no longer needs Python or `requests`.
- `qwen_llama.ts` / `run_qwen_llama.sh` are generalized into the `llama` command.
- `lm-studio-compat-proxy` is the `proxy` command; its default upstream is llama-server on
  port 8080.
- VRAM sweeps and automatic context fitting are the next natural llama-tooling module.
- The Qwen 3.5 vLLM GGUF monkey-patch stays outside the core until vLLM support is worth
  stabilizing.
