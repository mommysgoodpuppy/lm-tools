import { assertEquals } from "jsr:@std/assert@1/equals";
import { assertRejects } from "jsr:@std/assert@1/rejects";
import {
  FreeAccessAdapter,
  FreeAccessError,
  FreeRouteOffer,
  FreeRouter,
  NoFreeRouteError,
  NormalizedAccessEvent,
  rejectOffer,
  RouteCooldowns,
  StreamCommittedError,
} from "./free_router.ts";

type Event = NormalizedAccessEvent & { value: string };

const freeOffer = (overrides: Partial<FreeRouteOffer> = {}): FreeRouteOffer => ({
  id: "openrouter/account-1/model-a",
  adapter: "test",
  provider: "openrouter",
  model: "model-a",
  accessClass: "free",
  pricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
  ...overrides,
});

Deno.test("admits only explicitly zero-cost remote offers by default", () => {
  assertEquals(rejectOffer(freeOffer()), undefined);
  assertEquals(rejectOffer(freeOffer({ accessClass: "contributor" })), undefined);
  assertEquals(rejectOffer(freeOffer({ pricing: undefined })), "unknown-pricing");
  assertEquals(
    rejectOffer(freeOffer({
      pricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0.01 },
    })),
    "non-zero-pricing",
  );
  assertEquals(rejectOffer(freeOffer({ accessClass: "local" })), "local-access-disabled");
  assertEquals(rejectOffer(freeOffer({ accessClass: "paid" })), "paid-access-disabled");
});

Deno.test("cooldowns can exclude one route or a whole provider", () => {
  let now = 1_000;
  const cooldowns = new RouteCooldowns(() => now);
  const first = freeOffer();
  const second = freeOffer({ id: "openrouter/account-2/model-b", model: "model-b" });
  cooldowns.record(first, { kind: "rate-limit", message: "slow down", retryAfterMs: 500 });
  assertEquals(cooldowns.remainingMs(first), 500);
  assertEquals(cooldowns.remainingMs(second), 0);
  now += 500;
  assertEquals(cooldowns.remainingMs(first), 0);

  cooldowns.record(first, {
    kind: "quota",
    message: "provider quota",
    scope: "provider",
    retryAfterMs: 1_000,
  });
  assertEquals(cooldowns.remainingMs(second), 1_000);
});

Deno.test("fails over without leaking events from a pre-commit attempt", async () => {
  const seen: string[] = [];
  const adapter: FreeAccessAdapter<string, Event> = {
    id: "test",
    async *stream(offer) {
      seen.push(offer.id);
      if (offer.id === "first") {
        yield { type: "metadata", commitsOutput: false, value: "private" };
        throw new FreeAccessError({ kind: "rate-limit", message: "limited" });
      }
      yield { type: "delta", commitsOutput: true, value: "hello" };
      yield { type: "done", commitsOutput: false, value: "done" };
    },
  };
  const router = new FreeRouter([adapter]);
  const events: Event[] = [];
  for await (
    const event of router.stream([
      freeOffer({ id: "first", priority: 0 }),
      freeOffer({ id: "second", priority: 1 }),
    ], "request")
  ) events.push(event);
  assertEquals(seen, ["first", "second"]);
  assertEquals(events.map((event) => event.value), ["hello", "done"]);
});

Deno.test("does not splice a second provider into a committed stream", async () => {
  const adapter: FreeAccessAdapter<string, Event> = {
    id: "test",
    async *stream(offer) {
      yield { type: "delta", commitsOutput: true, value: offer.id };
      throw new Error("connection lost");
    },
  };
  const router = new FreeRouter([adapter]);
  const consume = async () => {
    for await (
      const _event of router.stream([freeOffer({ id: "first" }), freeOffer({ id: "second" })], "")
    ) {
      // Consume the stream to surface its terminal error.
    }
  };
  await assertRejects(consume, StreamCommittedError, "failed after commit");
});

Deno.test("reports no route when every offer has unknown or non-zero pricing", async () => {
  const router = new FreeRouter<string, Event>([]);
  const consume = async () => {
    for await (
      const _event of router.stream([
        freeOffer({ pricing: undefined }),
        freeOffer({
          id: "paid",
          pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 },
        }),
      ], "")
    ) {
      // No event can be emitted.
    }
  };
  await assertRejects(consume, NoFreeRouteError, "No eligible free inference route");
});

Deno.test("bounds provider attempts", async () => {
  const seen: string[] = [];
  const adapter: FreeAccessAdapter<string, Event> = {
    id: "test",
    async *stream(offer) {
      seen.push(offer.id);
      yield { type: "metadata", commitsOutput: false, value: "private" };
      throw new FreeAccessError({ kind: "unavailable", message: "offline" });
    },
  };
  const router = new FreeRouter([adapter], { maxAttempts: 2 });
  const consume = async () => {
    for await (
      const _event of router.stream([
        freeOffer({ id: "one", priority: 1 }),
        freeOffer({ id: "two", priority: 2 }),
        freeOffer({ id: "three", priority: 3 }),
      ], "")
    ) {
      // No attempt produces output.
    }
  };
  await assertRejects(consume, NoFreeRouteError, "All free routes failed");
  assertEquals(seen, ["one", "two"]);
});

Deno.test("cancellation never fails over", async () => {
  const controller = new AbortController();
  const seen: string[] = [];
  const events: string[] = [];
  const adapter: FreeAccessAdapter<string, Event> = {
    id: "test",
    async *stream(offer) {
      seen.push(offer.id);
      yield { type: "metadata", commitsOutput: false, value: "private" };
      controller.abort(new DOMException("cancelled", "AbortError"));
      throw controller.signal.reason;
    },
  };
  const router = new FreeRouter([adapter]);
  const consume = async () => {
    for await (
      const _event of router.stream(
        [freeOffer({ id: "one" }), freeOffer({ id: "two" })],
        "",
        controller.signal,
        (event) => events.push(event.type),
      )
    ) {
      // Cancellation occurs before output.
    }
  };
  await assertRejects(consume, DOMException, "cancelled");
  assertEquals(seen, ["one"]);
  assertEquals(events, ["attempt", "cancelled"]);
});
