# Free inference router boundary

The free router belongs in `lm-tools` because selection, failover, and usage observability are
shared inference infrastructure. Account enrollment and authentication do not belong here.

## Ownership

`lm-tools` owns:

- admission based on effective zero pricing;
- free and contributor-tier route selection;
- per-route, per-model, and per-provider cooldowns;
- failover before streamed output is committed;
- normalized attempt, failure, usage, and latency events;
- the OpenAI-compatible serving surface.

An access adapter owns:

- API keys, OAuth, browser/device login, and token refresh;
- provider-specific HTTP and streaming protocols;
- credential storage and account selection;
- translating provider errors and streams into the router contract.

A consuming project owns enabled providers, account enrollment, secret inputs, deployment, and
whether paid or local routes may be used. The router defaults both paid and local inference off.

## OMP consumer profiles

`src/free_router_omp.ts` turns one or more configured public lanes into a keyless OMP `models.yml`
provider. This supports separate primary and worker lanes in one isolated profile. The generated
profile contains only public model ids, limits, zero cost, and the local/router base URL. It
deliberately omits the auth-gateway bearer-token path and concrete upstream routes.
`freeRouterPublicModelIdentity()` separately returns the eligible route identity for an attempt
fingerprint, without authentication state. This keeps runtime configuration least-privileged while
still making a campaign attributable when route membership or ordering changes.

Consumers should place the generated `models.yml` in an isolated OMP agent directory and launch OMP
with `PI_CODING_AGENT_DIR` pointing at that directory. A free-router lane being technically usable
does not authorize arbitrary project artifacts for remote inference; the consuming campaign owns
that policy.

## OMP access adapter

The router depends on an interface, not on a particular provider library. Its first implementation
wraps OMP's HTTP auth-gateway, pinned to a reviewed source revision under `vendor/omp`. OMP's
auth-broker owns provider credentials, OAuth refresh, and account selection. The lm-tools adapter
holds only the gateway's bearer token and sends provider-qualified model ids such as
`groq/llama-3.3-70b-versatile`. Raw provider credentials must not appear in offers, router events,
logs, or returned errors.

The adapter uses OMP's OpenAI-compatible streaming endpoint. It treats role and metadata chunks as
private pre-commit events; text, reasoning, and tool-call deltas commit the stream. HTTP and
streaming error envelopes are normalized into the router's failure classes.

`GET /v1/models` is discovery, not free admission. OMP's catalog does not establish the effective
price for a particular account tier, so a consuming project must separately publish an explicitly
zero-priced `FreeRouteOffer`. Missing pricing remains ineligible.

`GET /v1/free-router/status` (also available as `/status`) exposes credential-free operational
state: active concrete provider/model routes, the last completed route, configured route order,
cooldown readiness, and recent failure classes. Provider error bodies and credentials are excluded.
This lets a consuming agent offer a zero-token status command while retaining `free-auto` as its
stable public model id.

`GET /v1/free-router/observer` adds a detailed, bounded audit history for private observability
clients. It contains the public lane, concrete route transitions, token usage, complete parsed model
request bodies (including system/user/assistant/tool messages and tool definitions), raw upstream
response chunks, and derived reasoning/output streams. Raw conversation and turn identifiers are
replaced with short hashes. HTTP headers, provider authentication state, and network-level transport
details are not captured and are declared in the response's `retention` metadata rather than
silently hidden.

The default in-memory ceiling is 2,000 requests or approximately 256 MiB of retained characters,
whichever is reached first. A single request body and each response/derived stream have separate 8
MiB ceilings; their `capture` metadata explicitly reports omissions or truncation. When
`observer.journalPath` is configured, begin/final request snapshots are appended as mode-`0600`
JSONL. A bounded tail is replayed into the live projection after router restarts, while every older
record remains in the append-only journal. Nothing is automatically rotated, compacted, or deleted.
`observer.maximumJournalBytes` is a hard capacity boundary of at most 2 GiB: the write is rejected
and lm-tools exits with status 78 before crossing it. A service supervisor must treat that status as
non-restartable so the operator can decide how to archive or replace the log. The observer exposes
journal size/status, malformed-record counts, live-projection evictions, and every persistence
boundary in its `retention` metadata.

Historical Hermes conversations can be imported with `scripts/backfill_hermes_audit.ts`. This is an
optional migration adapter, not a runtime dependency: it reads Hermes SQLite through an Incus
instance, emits deterministic records into the same journal, and marks request/response data as
reconstructed with an explicit list of unavailable wire details. Conversation IDs use the router's
normal hash, so later live requests for an imported Hermes session continue in the same observer
chat. A mode-`0600` sidecar makes the one-time import idempotent.

An effective offer identifies an opaque account/provider/model route and publishes its access class
and current effective pricing. Missing pricing is not free. Every published price dimension must be
finite and exactly zero for admission. A contributor tier is acceptable when its effective pricing
is zero; a paid route still requires an explicit policy opt-in.

OMP is transport and account infrastructure, not the free-routing policy. Provider coverage must be
verified at the pinned revision. Nous still needs a separate access adapter or can remain behind
Hermes' provider integration until OMP gains equivalent support.

## Pinned OMP source

OMP is present as the `vendor/omp` submodule. `vendor/omp.version` records the reviewed tag, commit,
runtime, and package version. This mirrors the source-pinning approach used for T3 while avoiding a
fork until lm-tools actually needs an OMP patch.

```bash
git submodule update --init vendor/omp
deno task omp:check
```

The check requires an `omp` executable matching the pinned package version. Account enrollment is
performed with OMP itself—for example, `omp auth-broker login <provider>`—and is intentionally not
reimplemented by lm-tools.

## Streaming and failover

Adapter events remain private until an event marked `commitsOutput` arrives. If the attempt fails
before that point, the router discards all buffered events, cools down the affected route, and tries
the next eligible offer. Once output is committed, changing models would splice two generations
together, so the failure is terminal and the client may retry as a new request.

Both attempts and pre-commit buffering are bounded. Client cancellation is terminal and never causes
the router to start another provider request. It emits a terminal `cancelled` route event so live
status no longer reports the route as active, without applying a failure cooldown.

This split lets provider access evolve independently. OMP can be replaced or supplemented by another
adapter without moving login flows into `lm-tools` or changing the routing policy.

## Campaign-owned sessions

A standing router service is right for a persistent claw, but a bounded campaign should own its
router instead of depending on one. `src/free_router_session.ts` provides `startFreeRouterSession`:

```ts
await using router = await startFreeRouterSession({
  listen: { host: "10.248.172.1", port: 1261 },
  models: [nvidiaGlm53Flash], // resolved, credential-free lanes
  ompGateway: { baseUrl: "http://127.0.0.1:4000", bearerTokenFile: "/path/to/token" },
  artifactsDirectory: join(workspace.artifactsDirectory, "router"),
});
// router.baseUrl, router.publicModels, router.receipt()
```

Properties:

- The server runs inside the calling process, so an interrupted campaign can never orphan a router.
- Only the declared lanes exist; the router cannot silently fall back to another provider or model,
  and startup fails closed if a lane is not eligible at readiness.
- `config.json` (credential-free), `audit.jsonl` (complete route decisions), and `receipt.json`
  (startup, readiness, shutdown reason) land beneath the supplied artifact directory.
- The fixed port is held by a fail-fast lease in `XDG_RUNTIME_DIR`; a second session on the same
  port is an error, never an eviction of another campaign's router.
- `shutdown(reason)` is idempotent and records why the router stopped; `await using` disposes with
  reason `disposed`, and an external `AbortSignal` records `cancelled`.
- Bearer tokens stay in memory. The materialized config and receipts never contain credential
  material.

For campaign composition, `src/campaign.ts` exposes `planAttempt` and `readAttemptRecord` so a
program can decide whether external resources must be started at all: a replay whose consuming
attempt is already durable starts no router and issues no model request again.
