# Why does lm-tools exist?

Running a local model looks like it should be one command:

```bash
llama-server --model model.gguf
```

That command can successfully start a process, answer HTTP requests, and still produce a system that
is wrong in ways the client cannot detect. Parameters can be accepted but ignored. A model can load
mostly into system RAM and become more than ten times slower. A second server can survive shutdown
and consume most of the GPU without owning a port. A nominally OpenAI-compatible stream can omit the
events a client needs to render it.

lm-tools exists because "the server returned 200" is not a sufficient definition of working.

It sits between model declarations, inference engines, clients, GPU resources, and network exposure.
Its job is to make all of those layers agree, reject unsafe or slow states, and record enough
evidence to explain what happened when they do not.

## Compatibility is not a boolean

"OpenAI compatible" usually means that an endpoint accepts roughly OpenAI-shaped JSON. It does not
mean every field has the same semantics or every stream follows the same lifecycle.

### Reasoning effort takes three different shapes

For the local Qwen3.8 deployment, the same setting appears in three forms:

```text
Responses API:        reasoning: { effort: "medium" }
Chat Completions API: reasoning_effort: "medium"
Qwen template input: chat_template_kwargs.reasoning_effort: "medium"
```

llama.cpp converts the Responses field into the Chat Completions field. Builds older than `b10434`
implement special behavior only for `none`; they accept other values without forwarding them to
Qwen's Jinja template.

That failure is silent. On such a build, requests using `low`, `medium`, or `xhigh` succeed, but all
produce the default `xhigh` prompt.

Upstream commit `7e4c0a96`, first released in `b10434` (2026-08-14), forwards the value itself. The
server merges request-supplied `chat_template_kwargs` first and then overwrites `reasoning_effort`
with an identically encoded value, so the proxy's write below is redundant on newer builds rather
than conflicting, and stays correct across both.

The model itself does support distinct levels. Rendering its template directly produces different
prompts for:

```text
low
medium
xhigh
```

lm-tools therefore translates client effort values into the model's declared wire values and also
sets `chat_template_kwargs.reasoning_effort`. The model declaration remains authoritative about the
literal values it accepts:

```json
"supportedReasoningLevels": ["none", "low", "medium", "xhigh"]
```

A model with unusual literals can normalize them explicitly:

```json
"supportedReasoningLevels": ["L", "M", "H"],
"reasonLevelMap": {
  "L": "low",
  "M": "medium",
  "H": "high"
}
```

Client vocabulary belongs in the machine-wide base configuration. That is where Pi's `off` and VS
Code's `high` are mapped onto canonical levels. For Qwen, VS Code `high` becomes model wire value
`xhigh`, while Pi can expose `xhigh` directly.

### A stream can contain the text and still be unusable

llama.cpp emits reasoning text, but clients expect a complete Responses event lifecycle. Pi requires
a reasoning output item before it accepts reasoning summary deltas. VS Code also expects
summary-part and completion events that the backend does not always emit.

lm-tools synthesizes the complete sequence:

```text
response.output_item.added
response.reasoning_summary_part.added
response.reasoning_summary_text.delta
response.reasoning_summary_text.done
response.reasoning_summary_part.done
response.output_item.done
```

Without the opening output item, Pi silently discards every reasoning delta because no thinking slot
exists for its output index.

### Prompt ingestion otherwise looks like a hang

Large prompts can take noticeable time before the first generated token. llama.cpp reports real
prompt evaluation progress in its diagnostic output, not through the Responses stream.

The combined deployment parses that progress and exposes it as a synthetic local reasoning item. Pi
and VS Code can then display messages such as:

```text
Evaluating prompt...
Prompt evaluation: 63% (9,216 tokens)
```

This data is UI state, not model reasoning. Every synthetic item uses an
`lm-tools-system-reasoning-...` ID. Before forwarding later conversation history, the proxy removes
those items recursively. It also removes an older text-prefix representation. This prevents a useful
progress display from leaking into the next model prompt and teaching the model to imitate local
diagnostics.

### Small request differences break otherwise valid clients

The proxy also handles concrete compatibility failures found in real requests:

- empty function parameter schemas are normalized into valid object schemas;
- leading developer messages are folded into instructions for templates that cannot consume them in
  the received shape;
- unsupported `previous_response_id` continuation state is removed;
- reasoning text events are adapted into reasoning summary events;
- proxy-generated reasoning artifacts are removed from replayed history.

These are deliberately targeted rewrites. The proxy is not trying to become another inference engine
or replace the model's chat template. It translates API semantics into the inputs the selected
backend and model template actually honor.

## A loaded model is not necessarily a GPU model

llama.cpp can honor `--n-gpu-layers all` imperfectly when VRAM is already occupied. It may load only
a small portion of the model on the GPU and place the rest in system RAM instead of failing.

This happened with Qwen3.8-27B:

```text
Expected generation: about 40 tokens/second
Silent fallback:      about 2.8 tokens/second
```

The API remained healthy and returned status 200. Only timing diagnostics and GPU residency exposed
the problem.

Each deployment therefore declares expected VRAM use. The base policy declares how much dedicated
VRAM must remain free. Before loading, lm-tools requires:

```text
currently free VRAM >= expected model VRAM + minimum remaining VRAM
```

If a game, browser, orphaned server, or another workload leaves too little room, deployment fails
instead of entering a technically functional but painfully slow state.

## Process lifecycle is part of model correctness

A previous llama-server process once received multiple shutdown signals, logged that it was exiting,
and remained alive under PID 1. It no longer owned the API port, but it retained most of the GPU. A
new server then started successfully and loaded mostly into system RAM.

A port check would not have detected the conflict.

Exclusive deployments now:

- acquire a machine-wide GPU lease;
- stop an earlier lease owner before starting;
- scan `/proc` for configured conflicting inference executables;
- send SIGTERM and wait for a bounded grace period;
- escalate stuck processes to SIGKILL;
- release the lease only when the owning deployment exits.

Multiple inference processes are allowed only through an explicit shared policy. Coexistence should
be an intentional memory and throughput configuration, not an accident.

For recovery without trusting another deployment to reconcile the machine:

```bash
deno task kill-everything
```

The emergency task stops configured user units, terminates configured inference processes, disables
configured Tailscale Serve mappings, and removes stale GPU ownership state.

## Local-only and remotely usable are different configurations

The model server and compatibility proxy bind to loopback. Binding them to `0.0.0.0` would also
expose an unauthenticated API on unrelated interfaces.

lm-tools keeps both services local and places Tailscale Serve in front of the compatibility proxy:

```text
Tailnet HTTPS URL
  -> Tailscale Serve
  -> 127.0.0.1:1235 Deno compatibility proxy
  -> 127.0.0.1:8080 llama-server
```

This provides a MagicDNS HTTPS name while preserving loopback-only backend listeners. The deployment
owns the Serve mapping and removes it during shutdown.

## Client configuration is generated, not remembered

A model declaration already contains its ID, display name, context window, output limit, modalities,
reasoning levels, endpoint topology, and networking policy. Hand-maintained client files duplicate
that information and drift.

Every deployment generates ignored, portable snippets under:

```text
api-jsons/<model-id>/
```

Current outputs include:

```text
pi.json
vscode.json
```

When Tailscale exposure is enabled, portable snippets use the machine's MagicDNS HTTPS URL. The
local VS Code configuration can still be reconciled automatically.

## Backend command lines are not stable configuration

llama.cpp has many flags, and support changes between builds. Raw argument arrays make a deployment
easy to write and difficult to validate.

lm-tools owns a typed subset of backend options. A deployment check validates:

- JSON Schema;
- model and executable paths;
- backend-specific constraints;
- generated long options against the installed executable's live `--help` output;
- GPU policy inputs and VRAM counters;
- client reasoning-level declarations and mappings.

The deployment file describes intent. Backend command lines are generated artifacts.

## Diagnostics need exact evidence

Compatibility bugs are difficult to diagnose from a final answer. lm-tools records:

- request shape and selected fields;
- every compatibility rewrite;
- upstream status and elapsed time;
- response usage;
- llama-server output and timing data;
- complete request bodies in ignored capture files.

Captures intentionally include local prompts and tool outputs, so they are sensitive. They exclude
request headers and authentication tokens and remain under ignored local paths by default.

These records made it possible to distinguish a 17-37 ms proxy path from a 47-second inference
request and identify 2.8-token/second CPU fallback as the actual problem.

## The principle

The direct tools are useful, but each owns only one layer:

- the inference engine knows how to run tensors;
- the model template knows how to format one model family;
- the client knows how to render its own event protocol;
- Tailscale knows how to expose a local socket;
- systemd knows how to supervise a declared process.

None of them verifies that the complete local-model system has the intended semantics and
performance.

lm-tools is the integration boundary that does.
