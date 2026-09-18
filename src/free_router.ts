/**
 * Provider-neutral routing policy for zero-cost inference.
 *
 * Authentication deliberately does not appear in these contracts. An access
 * adapter owns credentials, refresh, provider protocols, and login tooling;
 * the router sees only effective offers and normalized stream events.
 */

export type AccessClass = "free" | "contributor" | "paid" | "local";

export interface EffectivePricing {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  cacheReadUsdPerMillion?: number;
  cacheWriteUsdPerMillion?: number;
}

export interface FreeRouteOffer {
  /** Stable opaque identity for one account/provider/model route. */
  id: string;
  adapter: string;
  provider: string;
  model: string;
  accessClass: AccessClass;
  /** Effective pricing for this account, after any free or contributor tier. */
  pricing?: EffectivePricing;
  /** Lower values are preferred. */
  priority?: number;
  /** Optional public routing lane, attached by the server for observability. */
  publicModel?: string;
}

export type OfferRejection =
  | "unknown-pricing"
  | "non-zero-pricing"
  | "paid-access-disabled"
  | "local-access-disabled";

export interface FreeRoutePolicy {
  allowPaid: boolean;
  allowLocal: boolean;
}

export const DEFAULT_FREE_ROUTE_POLICY: Readonly<FreeRoutePolicy> = {
  allowPaid: false,
  allowLocal: false,
};

export function rejectOffer(
  offer: FreeRouteOffer,
  policy: FreeRoutePolicy = DEFAULT_FREE_ROUTE_POLICY,
): OfferRejection | undefined {
  if (offer.accessClass === "local" && !policy.allowLocal) return "local-access-disabled";
  if (offer.accessClass === "paid" && !policy.allowPaid) return "paid-access-disabled";
  if (!offer.pricing) return "unknown-pricing";
  const prices = Object.values(offer.pricing);
  if (prices.length < 2 || prices.some((price) => !Number.isFinite(price) || price !== 0)) {
    return "non-zero-pricing";
  }
  return undefined;
}

export type FailureKind =
  | "rate-limit"
  | "quota"
  | "unavailable"
  | "auth"
  | "invalid-request"
  | "unknown";

export type CooldownScope = "route" | "model" | "provider";

export interface AccessFailure {
  kind: FailureKind;
  message: string;
  scope?: CooldownScope;
  retryAfterMs?: number;
  cause?: unknown;
}

export interface NormalizedAccessEvent {
  /** Only a commit event may become visible to a client. */
  commitsOutput: boolean;
  type: string;
  value?: unknown;
}

export interface FreeAccessAdapter<TRequest, TEvent extends NormalizedAccessEvent> {
  readonly id: string;
  /**
   * Execute through the adapter's own credential and transport boundary.
   * Implementations must not place credentials in returned events or errors.
   */
  stream(
    offer: FreeRouteOffer,
    request: TRequest,
    signal?: AbortSignal,
  ): AsyncIterable<TEvent>;
}

export interface RouterAttemptEvent {
  type: "attempt" | "failure" | "committed" | "completed";
  offer: FreeRouteOffer;
  failure?: AccessFailure;
}

export interface FreeRouterOptions {
  policy?: Partial<FreeRoutePolicy>;
  now?: () => number;
  onEvent?: (event: RouterAttemptEvent) => void;
  maxAttempts?: number;
  maxBufferedEvents?: number;
}

const DEFAULT_COOLDOWNS: Readonly<Record<FailureKind, number>> = {
  "rate-limit": 60_000,
  quota: 15 * 60_000,
  unavailable: 30_000,
  auth: 5 * 60_000,
  "invalid-request": 0,
  unknown: 30_000,
};

function cooldownKey(offer: FreeRouteOffer, scope: CooldownScope): string {
  if (scope === "provider") return `provider:${offer.provider}`;
  if (scope === "model") return `model:${offer.provider}/${offer.model}`;
  return `route:${offer.id}`;
}

function failureFrom(error: unknown): AccessFailure {
  if (error instanceof FreeAccessError) return error.failure;
  return {
    kind: "unknown",
    message: error instanceof Error ? error.message : String(error),
    cause: error,
  };
}

export class FreeAccessError extends Error {
  constructor(readonly failure: AccessFailure) {
    super(failure.message, { cause: failure.cause });
    this.name = "FreeAccessError";
  }
}

export class StreamCommittedError extends Error {
  constructor(
    readonly offer: FreeRouteOffer,
    readonly failure: AccessFailure,
  ) {
    super(`Stream from ${offer.provider}/${offer.model} failed after commit: ${failure.message}`, {
      cause: failure.cause,
    });
    this.name = "StreamCommittedError";
  }
}

export class NoFreeRouteError extends Error {
  constructor(readonly failures: ReadonlyArray<{ offer: FreeRouteOffer; failure: AccessFailure }>) {
    super(failures.length === 0 ? "No eligible free inference route" : "All free routes failed");
    this.name = "NoFreeRouteError";
  }
}

/** Tracks temporary exclusions without knowing anything about account credentials. */
export class RouteCooldowns {
  #until = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  record(offer: FreeRouteOffer, failure: AccessFailure): void {
    const duration = Math.max(0, failure.retryAfterMs ?? DEFAULT_COOLDOWNS[failure.kind]);
    if (duration === 0) return;
    this.#until.set(cooldownKey(offer, failure.scope ?? "route"), this.now() + duration);
  }

  remainingMs(offer: FreeRouteOffer): number {
    const now = this.now();
    let remaining = 0;
    for (const scope of ["route", "model", "provider"] as const) {
      const key = cooldownKey(offer, scope);
      const until = this.#until.get(key) ?? 0;
      remaining = Math.max(remaining, until - now);
      if (until <= now) this.#until.delete(key);
    }
    return Math.max(0, remaining);
  }
}

export class FreeRouter<TRequest, TEvent extends NormalizedAccessEvent> {
  readonly cooldowns: RouteCooldowns;
  readonly policy: FreeRoutePolicy;
  #adapters: ReadonlyMap<string, FreeAccessAdapter<TRequest, TEvent>>;
  #onEvent?: (event: RouterAttemptEvent) => void;
  #maxAttempts: number;
  #maxBufferedEvents: number;

  constructor(
    adapters: Iterable<FreeAccessAdapter<TRequest, TEvent>>,
    options: FreeRouterOptions = {},
  ) {
    this.policy = { ...DEFAULT_FREE_ROUTE_POLICY, ...options.policy };
    this.cooldowns = new RouteCooldowns(options.now);
    this.#onEvent = options.onEvent;
    this.#maxAttempts = positiveInteger(options.maxAttempts ?? 8, "maxAttempts");
    this.#maxBufferedEvents = positiveInteger(
      options.maxBufferedEvents ?? 256,
      "maxBufferedEvents",
    );
    this.#adapters = new Map(Array.from(adapters, (adapter) => [adapter.id, adapter]));
  }

  eligible(offers: Iterable<FreeRouteOffer>): FreeRouteOffer[] {
    return Array.from(offers)
      .filter((offer) =>
        !rejectOffer(offer, this.policy) && this.cooldowns.remainingMs(offer) === 0
      )
      .sort((left, right) =>
        (left.priority ?? 0) - (right.priority ?? 0) || left.id.localeCompare(right.id)
      );
  }

  /**
   * Fail over while output is still private. After the first commit event,
   * errors are terminal because mixing providers would corrupt the response.
   */
  async *stream(
    offers: Iterable<FreeRouteOffer>,
    request: TRequest,
    signal?: AbortSignal,
    onEvent?: (event: RouterAttemptEvent) => void,
  ): AsyncGenerator<TEvent> {
    const observe = (event: RouterAttemptEvent) => {
      this.#onEvent?.(event);
      onEvent?.(event);
    };
    const failures: Array<{ offer: FreeRouteOffer; failure: AccessFailure }> = [];
    for (const offer of this.eligible(offers).slice(0, this.#maxAttempts)) {
      throwIfAborted(signal);
      const adapter = this.#adapters.get(offer.adapter);
      if (!adapter) {
        const failure: AccessFailure = {
          kind: "unavailable",
          message: `Access adapter is not installed: ${offer.adapter}`,
        };
        failures.push({ offer, failure });
        this.cooldowns.record(offer, failure);
        observe({ type: "failure", offer, failure });
        continue;
      }

      observe({ type: "attempt", offer });
      const pending: TEvent[] = [];
      let committed = false;
      try {
        for await (const event of adapter.stream(offer, request, signal)) {
          if (!committed) {
            pending.push(event);
            if (pending.length > this.#maxBufferedEvents) {
              throw new FreeAccessError({
                kind: "unavailable",
                message:
                  `Access adapter exceeded the ${this.#maxBufferedEvents}-event pre-commit buffer`,
              });
            }
            if (!event.commitsOutput) continue;
            committed = true;
            observe({ type: "committed", offer });
            for (const buffered of pending) yield buffered;
            pending.length = 0;
            continue;
          }
          yield event;
        }
        if (!committed) {
          throw new FreeAccessError({
            kind: "unavailable",
            message: "Access adapter ended before producing output",
          });
        }
        observe({ type: "completed", offer });
        return;
      } catch (error) {
        throwIfAborted(signal);
        const failure = failureFrom(error);
        observe({ type: "failure", offer, failure });
        if (committed) throw new StreamCommittedError(offer, failure);
        failures.push({ offer, failure });
        this.cooldowns.record(offer, failure);
      }
    }
    throw new NoFreeRouteError(failures);
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}
