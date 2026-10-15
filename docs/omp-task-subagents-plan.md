# OMP-backed task agents

Status: implementation started.

## Objective

Turn `lm task` from a one-shot prompt sent to OMP's top-level agent into a real, native OMP
subagent that remains observable and controllable from outside OMP.

The user-visible task is the primary subagent. OMP's top-level session is an implementation detail
that owns the model registry, settings, extensions, async jobs, agent registry, artifacts, and
subagent lifecycle. It must not perform inference.

```text
lm task / programmatic caller
  -> lm-tools OMP host
       -> synthetic, non-inferencing OMP root session
            -> primary native OMP subagent (the externally visible task)
                 -> optional nested OMP subagents
```

`lm task` is the first client of a reusable lm-tools OMP runtime. Campaigns and other programs may
use that runtime directly and impose different scheduling, persistence, interpretation, and policy.

## Required behavior

1. Spawn the primary task through OMP's native structured-subagent runtime, not by prompting the
   root session.
2. Give every worker an explicit model or model role. The synthetic root is never a worker-model
   fallback.
3. Preserve OMP-native behavior: agent definitions, tools, nested spawning, isolation, output
   schemas, artifacts, usage, parking, revival, and lifecycle.
4. Project the primary agent and all descendants outside OMP:
   - registry identity, lineage, status, and activity;
   - lifecycle, progress, message, and tool events;
   - incremental transcripts and final output;
   - usage and operational termination;
   - steer, follow-up, abort, kill, and revive controls.
5. Keep the root dormant. Worker completion delivery must not wake or invoke the root model.
6. Retain current process supervision: timeout, external cancellation, TERM/KILL escalation, free
   router ownership, isolated session state, raw events, stderr, and no orphaned processes.
7. Keep the existing foreground `lm task` contract as a convenience implemented on the same hosted
   task-agent path.

## Architecture

### OMP host extension

An lm-tools-owned OMP extension is loaded explicitly for hosted tasks. It:

- registers `lm-tools/control-plane`, a zero-cost local model with a custom API implementation that
  fails clearly if inference is attempted;
- starts a private versioned control endpoint supplied by lm-tools;
- resolves the root `AgentSession` and invokes OMP's exported structured-subagent APIs;
- uses OMP's registry and lifecycle manager for inspection, messaging, kill, and revival;
- publishes subagent events and transcript locations without inventing parallel agent state; and
- suppresses async-result delivery into the root conversation.

The extension is allowed to depend on OMP internals because lm-tools pins OMP source. Its startup
handshake must report both the bridge protocol version and OMP package version. An unsupported
combination fails closed.

### Managed OMP runtime

lm-tools owns the OMP runtime used for every hosted task. It never discovers or invokes an `omp`
executable from `PATH`, and it does not read or mutate a system OMP installation. The managed
runtime is materialized from the reviewed `vendor/omp` revision into an lm-tools-owned,
revision-scoped runtime directory. Its executable, extension bridge, dependency state, and build
receipt are one atomic compatibility unit.

An explicit executable override remains only as a test seam. It is not a production fallback and
must never silently select the user's system OMP.

lm-tools launches one managed OMP process per runtime. The process boundary provides version
isolation, crash containment, resource supervision, clean cancellation, and separation of OMP's
process-global registries.

OMP RPC remains useful for its existing protocol-v2 event stream, session state, usage, and
incremental subagent transcript support. The extension control endpoint supplies missing
externally initiated operations such as spawn and native agent control. lm-tools presents both as
one API.

### Public runtime API

The reusable API should be expressed in task-agent terms rather than OMP root-session terms:

```ts
interface OmpRuntime {
  spawn(request: AgentSpawnRequest): Promise<AgentHandle>;
  list(): Promise<AgentSnapshot[]>;
  send(agentId: string, message: string, mode: "steer" | "followUp"): Promise<void>;
  abort(agentId: string): Promise<void>;
  kill(agentId: string): Promise<void>;
  revive(agentId: string): Promise<void>;
  transcript(agentId: string, cursor?: number): Promise<TranscriptPage>;
  events(cursor?: number): AsyncIterable<RuntimeEvent>;
  wait(agentIds?: string[]): Promise<AgentResult[]>;
  shutdown(): Promise<void>;
}
```

The API must accept a per-spawn model selector. OMP's `StructuredSubagentRequest.model` already
provides the required precedence above settings, agent defaults, and parent fallback.

### Durable runtime state

Every runtime gets an owner-only directory containing:

- immutable invocation/profile description;
- control socket metadata and bridge handshake;
- append-only normalized events with monotonic cursors;
- raw OMP RPC events and stderr;
- native OMP root and subagent sessions;
- agent output and patch artifacts; and
- a final operational receipt.

Live state comes from OMP. The lm-tools event journal supports reconnect and post-mortem inspection;
it is not a second mutable agent registry.

## CLI direction

The eventual attachable surface is:

```text
lm task start ...
lm task watch TASK
lm task status TASK --json
lm task transcript TASK [AGENT]
lm task send TASK [AGENT] --steer|--follow-up MESSAGE
lm task hub TASK
lm task kill TASK [AGENT]
lm task wait TASK
lm task close TASK
```

The existing invocation remains a foreground shorthand:

```text
lm task ... = start -> spawn primary -> wait -> print result -> close
```

The task's synthetic root is hidden. `lm task hub` presents the primary agent as the visible root and
nests its OMP-native descendants underneath it.

## Implementation phases

### Phase 1: bridge foundation

- [ ] Add revision-scoped managed OMP runtime resolution and remove the production `PATH` fallback.
- [ ] Add a materialization/build command and receipt for the pinned OMP source and Bun runtime.
- [ ] Add the OMP host extension.
- [ ] Register and test the synthetic control-plane provider/model.
- [ ] Define a small versioned NDJSON control protocol and handshake.
- [ ] Add a local client with bounded frames, request correlation, and clean disconnect behavior.
- [ ] Verify extension/package compatibility against the pinned OMP revision.

### Phase 2: native primary subagent

- [ ] Implement `spawn` with `runStructuredSubagent`, explicit model selection, stable identity,
      keep-alive lifecycle, and progress events.
- [ ] Register spawned work in OMP's async job manager without permitting completion delivery to
      wake the root.
- [ ] Return the primary agent identity immediately and preserve its output/session artifacts.
- [ ] Replace the top-level `--mode json` prompt in `runOmpTask` with the hosted primary-agent path.

### Phase 3: external Hub controls

- [ ] Implement list/status with complete parent-child lineage.
- [ ] Implement incremental transcripts.
- [ ] Implement steer/follow-up, abort, kill, and revive using native lifecycle operations.
- [ ] Persist normalized events and expose reconnect by cursor.
- [ ] Add `watch`, `status`, `transcript`, `send`, `hub`, `kill`, `wait`, and `close` CLI clients.

### Phase 4: compatibility and reusable API

- [ ] Reimplement foreground `lm task` as start/spawn/wait/close while retaining its current final
      text and JSON envelope behavior.
- [ ] Preserve free-router fail-closed routing and per-task router ownership.
- [ ] Extract the generic `OmpRuntime` API for campaign and application code.
- [ ] Add an optional MCP adapter only after the runtime and CLI contracts stabilize.

## Verification

- The OMP root makes zero provider requests during a task.
- The primary task is registered as `kind: sub` and has a native JSONL transcript.
- A controller can observe a running tool call and steer the primary agent.
- A controller can see, message, kill, and revive nested agents.
- Completion cannot enqueue an inference turn on the synthetic root.
- Timeout/cancellation kills the primary, descendants, OMP process, and owned router.
- A controller can reconnect and resume events from its last durable cursor.
- Existing paid/free task tests and operational receipts remain compatible.
- `lm task` never executes or modifies a system `omp` installation.
- The bridge rejects unsupported or incompletely materialized managed OMP runtimes with an
  actionable error.

## Current compatibility note

The repository currently pins OMP 18.2.5 at commit
`37273117021129e96bd05d8277b140ec3fd61990`. A system OMP installation may be any version; it is
outside this design and is neither inspected nor used by hosted tasks. Checked behavior and bridge
compatibility are tied to the managed runtime materialized from the pin until the repository pin is
deliberately advanced.
