import { Ajv2020, type ErrorObject } from "npm:ajv@8.17.1/dist/2020.js";
import { dirname, resolve } from "jsr:@std/path@1";
import { AppendOnlyTextLog, MAXIMUM_TEXT_LOG_BYTES, TextLogCapacityError } from "./log.ts";
import {
  FreeRouteOffer,
  FreeRoutePolicy,
  FreeRouter,
  NoFreeRouteError,
  rejectOffer,
  RouterAttemptEvent,
} from "./free_router.ts";
import { OmpGatewayAdapter, OmpGatewayEvent, OpenAIChatCompletionRequest } from "./omp_gateway.ts";

const PROJECT_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const FREE_ROUTER_SCHEMA = `${PROJECT_ROOT}/schemas/free-router.schema.json`;

export interface FreeRouterModelConfig {
  id: string;
  contextLength?: number;
  maxOutputTokens?: number;
  offers: FreeRouteOffer[];
}

export interface FreeRouterServiceConfig {
  $schema?: string;
  version: 1;
  listen: { host: string; port: number };
  omp: { baseUrl: string; bearerTokenFile?: string };
  policy?: Partial<FreeRoutePolicy>;
  observer?: {
    journalPath?: string;
    maximumRequests?: number;
    maximumRetainedCharacters?: number;
    maximumJournalBytes?: number;
  };
  models: FreeRouterModelConfig[];
}

export interface LoadedFreeRouterServiceConfig extends FreeRouterServiceConfig {
  sourcePath: string;
  omp: { baseUrl: string; bearerTokenFile?: string; resolvedBearerTokenFile?: string };
}

export function freeRouterUsage(): string {
  return `Usage: lm free-router CONFIG [options]

Serve explicitly zero-priced OMP routes through an OpenAI-compatible endpoint.

Options:
  --check  Validate configuration and referenced secret files without serving
  --help   Show this help

Provider login, refresh, and account selection remain owned by OMP.`;
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ");
}

export async function loadFreeRouterConfig(path: string): Promise<LoadedFreeRouterServiceConfig> {
  const sourcePath = resolve(path);
  const config = JSON.parse(await Deno.readTextFile(sourcePath)) as FreeRouterServiceConfig;
  const schema = JSON.parse(await Deno.readTextFile(FREE_ROUTER_SCHEMA));
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
  if (!validate(config)) {
    throw new Error(
      `Invalid free-router config ${sourcePath}: ${formatAjvErrors(validate.errors)}`,
    );
  }

  const ids = new Set<string>();
  const offerIdentities = new Map<string, string>();
  for (const model of config.models) {
    if (ids.has(model.id)) throw new Error(`Duplicate public model id: ${model.id}`);
    ids.add(model.id);
    const modelOfferIds = new Set<string>();
    for (const offer of model.offers) {
      if (modelOfferIds.has(offer.id)) {
        throw new Error(`Duplicate route offer id in public model ${model.id}: ${offer.id}`);
      }
      modelOfferIds.add(offer.id);
      const identity = JSON.stringify({
        adapter: offer.adapter,
        provider: offer.provider,
        model: offer.model,
        accessClass: offer.accessClass,
        pricing: offer.pricing,
      });
      const existing = offerIdentities.get(offer.id);
      if (existing !== undefined && existing !== identity) {
        throw new Error(`Conflicting route offer identity: ${offer.id}`);
      }
      offerIdentities.set(offer.id, identity);
    }
  }

  const bearerTokenFile = config.omp.bearerTokenFile;
  const resolvedBearerTokenFile = bearerTokenFile
    ? resolve(dirname(sourcePath), bearerTokenFile)
    : undefined;
  if (resolvedBearerTokenFile) {
    const stat = await Deno.stat(resolvedBearerTokenFile);
    if (!stat.isFile) throw new Error(`OMP bearer token is not a file: ${resolvedBearerTokenFile}`);
  }
  return {
    ...config,
    sourcePath,
    omp: { ...config.omp, resolvedBearerTokenFile },
  };
}

export async function freeRouterCommand(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(freeRouterUsage());
    return;
  }
  let configPath: string | undefined;
  let check = false;
  for (const arg of args) {
    if (arg === "--check") check = true;
    else if (arg.startsWith("-")) throw new Error(`Unknown free-router option: ${arg}`);
    else if (configPath) throw new Error("Only one free-router config may be supplied");
    else configPath = arg;
  }
  if (!configPath) throw new Error(`A free-router config is required\n\n${freeRouterUsage()}`);

  const config = await loadFreeRouterConfig(configPath);
  const token = config.omp.resolvedBearerTokenFile
    ? (await Deno.readTextFile(config.omp.resolvedBearerTokenFile)).trim()
    : undefined;
  if (config.omp.resolvedBearerTokenFile && !token) {
    throw new Error(`OMP bearer token file is empty: ${config.omp.resolvedBearerTokenFile}`);
  }
  if (check) {
    console.log(`Valid free-router config with ${config.models.length} public model(s)`);
    return;
  }

  const adapter = new OmpGatewayAdapter({ baseUrl: config.omp.baseUrl, bearerToken: token });
  const handler = createFreeRouterHandler(config, adapter, logRouterEvent);
  Deno.serve({ hostname: config.listen.host, port: config.listen.port }, handler);
}

export function createFreeRouterHandler(
  config: FreeRouterServiceConfig,
  adapter: OmpGatewayAdapter,
  onEvent: (event: RouterAttemptEvent | Record<string, unknown>) => void = logRouterEvent,
): (request: Request) => Promise<Response> {
  const models = new Map(config.models.map((model) => [model.id, model]));
  const status = new FreeRouterStatus();
  const observer = new FreeRouterObserver(config.observer);
  const router = new FreeRouter<OpenAIChatCompletionRequest, OmpGatewayEvent>([adapter], {
    policy: config.policy,
    onEvent: (event) => {
      status.observe(event);
      onEvent(event);
    },
  });

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") {
      return json(200, { ok: true, eligibleModels: eligibleModelIds(models, router) });
    }
    if (request.method === "GET" && url.pathname === "/v1/models") {
      return json(200, {
        object: "list",
        data: eligibleModels(models, router).map((model) => ({
          id: model.id,
          object: "model",
          owned_by: "lm-tools",
          ...(model.contextLength ? { context_length: model.contextLength } : {}),
          ...(model.maxOutputTokens ? { max_output_tokens: model.maxOutputTokens } : {}),
        })),
      });
    }
    if (
      request.method === "GET" &&
      (url.pathname === "/status" || url.pathname === "/v1/free-router/status")
    ) {
      return json(200, status.snapshot(models, router));
    }
    if (request.method === "GET" && url.pathname === "/v1/free-router/observer") {
      return json(
        200,
        observer.snapshot(
          status.snapshot(models, router),
          url.searchParams.get("detail") !== "summary",
        ),
      );
    }
    if (request.method === "GET" && url.pathname === "/v1/free-router/observer/request") {
      const observed = observer.request(url.searchParams.get("id") ?? "");
      return observed
        ? json(200, observed)
        : json(404, { error: { type: "not_found", message: "Observed request not found" } });
    }
    if (request.method === "GET" && url.pathname === "/v1/free-router/observer/conversation") {
      const requests = observer.conversation(url.searchParams.get("id") ?? "");
      return requests.length > 0
        ? json(200, { requests })
        : json(404, { error: { type: "not_found", message: "Observed conversation not found" } });
    }
    if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
      return json(404, { error: { type: "invalid_request_error", message: "Route not found" } });
    }

    let body: OpenAIChatCompletionRequest;
    try {
      body = await request.json();
    } catch {
      return json(400, { error: { type: "invalid_request_error", message: "Invalid JSON body" } });
    }
    if (typeof body.model !== "string" || !Array.isArray(body.messages)) {
      return json(400, {
        error: { type: "invalid_request_error", message: "`model` and `messages` are required" },
      });
    }
    const publicModel = models.get(body.model);
    if (!publicModel) {
      return json(404, {
        error: { type: "invalid_request_error", message: `Unknown model: ${body.model}` },
      });
    }

    const offers = publicModel.offers.map((offer) => ({ ...offer, publicModel: publicModel.id }));
    const conversation = await observerConversation(request);
    const turnId = await observerOpaqueId(
      request.headers.get("x-lm-tools-turn-id"),
      "turn",
      crypto.randomUUID(),
    );
    const requestId = observer.begin(
      publicModel.id,
      conversation,
      turnId,
      body,
    );
    const iterator = router.stream(
      offers,
      body,
      request.signal,
      (event) => observer.observeRoute(requestId, event),
    );
    let first: IteratorResult<OmpGatewayEvent>;
    try {
      first = await iterator.next();
    } catch (error) {
      observer.fail(requestId, error);
      return routerErrorResponse(error);
    }
    if (first.done) {
      const error = new NoFreeRouteError([]);
      observer.fail(requestId, error);
      return routerErrorResponse(error);
    }

    if (body.stream === false) {
      try {
        return json(
          200,
          await collectCompletion(body.model, first.value, iterator, onEvent, observer, requestId),
        );
      } catch (error) {
        observer.fail(requestId, error);
        return routerErrorResponse(error);
      }
    }

    return new Response(
      encodeOpenAIStream(first.value, iterator, body.model, onEvent, observer, requestId),
      {
        status: 200,
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      },
    );
  };
}

interface FreeRouterObservedRequest {
  id: string;
  conversationId: string;
  conversationSource: string;
  conversationLabel?: string;
  turnId: string;
  userMessage: string;
  requestBody?: OpenAIChatCompletionRequest;
  responseChunks: unknown[];
  capture: {
    requestBody: "complete" | "omitted";
    requestBodyCharacters: number;
    latestUserMessage: "complete" | "truncated";
    responseChunks: "complete" | "truncated";
    responseChunkCharacters: number;
    reasoning: "complete" | "truncated";
    content: "complete" | "truncated";
  };
  publicModel: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  status: "routing" | "streaming" | "completed" | "failed";
  reasoning: string;
  content: string;
  routes: Array<Record<string, unknown>>;
  usage?: Record<string, unknown>;
  error?: string;
}

/**
 * Bounded, memory-only inference audit history for the private observer UI.
 * Parsed model requests and upstream response chunks are retained; transport
 * headers and provider authentication state never enter this store.
 */
export class FreeRouterObserver {
  static readonly maximumRequests = 2_000;
  static readonly maximumRetainedCharacters = 256 * 1024 * 1024;
  static readonly maximumRequestCharacters = 8 * 1024 * 1024;
  static readonly maximumFieldCharacters = 8 * 1024 * 1024;
  static readonly maximumResponseChunkCharacters = 8 * 1024 * 1024;
  readonly #requests: FreeRouterObservedRequest[] = [];
  readonly #maximumRequests: number;
  readonly #maximumRetainedCharacters: number;
  readonly #journalPath?: string;
  readonly #maximumJournalBytes: number;
  readonly #journalLog?: AppendOnlyTextLog;
  #retainedCharacters = 0;
  #evictedRequests = 0;
  #journalRecordsLoaded = 0;
  #journalMalformedRecords = 0;
  #journalPending: Promise<void> = Promise.resolve();

  constructor(options: FreeRouterServiceConfig["observer"] = {}) {
    this.#maximumRequests = options?.maximumRequests ?? FreeRouterObserver.maximumRequests;
    this.#maximumRetainedCharacters = options?.maximumRetainedCharacters ??
      FreeRouterObserver.maximumRetainedCharacters;
    this.#journalPath = options?.journalPath ? resolve(options.journalPath) : undefined;
    this.#maximumJournalBytes = options?.maximumJournalBytes ?? MAXIMUM_TEXT_LOG_BYTES;
    if (this.#maximumJournalBytes > MAXIMUM_TEXT_LOG_BYTES) {
      throw new Error(`Free-router audit journal cannot exceed ${MAXIMUM_TEXT_LOG_BYTES} bytes`);
    }
    this.#journalLog = this.#journalPath
      ? new AppendOnlyTextLog(this.#journalPath, { maximumBytes: this.#maximumJournalBytes })
      : undefined;
    this.#restoreJournal();
  }

  begin(
    publicModel: string,
    conversation: { id: string; source: string } = { id: "unattributed", source: "agent" },
    turnId: string = crypto.randomUUID(),
    requestBody: OpenAIChatCompletionRequest = { messages: [] },
  ): string {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const serializedRequest = JSON.stringify(requestBody);
    const requestBodyCharacters = serializedRequest.length;
    const retainRequestBody = requestBodyCharacters <= FreeRouterObserver.maximumRequestCharacters;
    const fullUserMessage = latestUserMessage(requestBody.messages);
    const userMessage = fullUserMessage.slice(-FreeRouterObserver.maximumFieldCharacters);
    const observed: FreeRouterObservedRequest = {
      id,
      conversationId: conversation.id,
      conversationSource: conversation.source,
      turnId,
      userMessage,
      ...(retainRequestBody ? { requestBody: structuredClone(requestBody) } : {}),
      responseChunks: [],
      capture: {
        requestBody: retainRequestBody ? "complete" : "omitted",
        requestBodyCharacters,
        latestUserMessage: userMessage.length === fullUserMessage.length ? "complete" : "truncated",
        responseChunks: "complete",
        responseChunkCharacters: 0,
        reasoning: "complete",
        content: "complete",
      },
      publicModel,
      startedAt: now,
      updatedAt: now,
      status: "routing",
      reasoning: "",
      content: "",
      routes: [],
    };
    this.#requests.push(observed);
    this.#retainedCharacters += retainRequestBody ? requestBodyCharacters : userMessage.length;
    this.#enforceRetention();
    this.#persist(observed);
    return id;
  }

  observeRoute(id: string, event: RouterAttemptEvent): void {
    const request = this.#find(id);
    if (!request) return;
    const now = new Date().toISOString();
    request.updatedAt = now;
    if (event.type === "committed") request.status = "streaming";
    if (event.type === "completed") {
      request.status = "completed";
      request.completedAt = now;
    }
    request.routes.push({
      type: event.type,
      at: now,
      ...publicOffer(event.offer),
      ...(event.failure
        ? { failure: { kind: event.failure.kind, message: event.failure.message } }
        : {}),
    });
    if (event.type === "completed") this.#persist(request);
  }

  observeChunk(id: string, value: unknown): void {
    const request = this.#find(id);
    if (!request || !isRecord(value)) return;
    request.updatedAt = new Date().toISOString();
    const serializedChunk = JSON.stringify(value);
    if (
      request.capture.responseChunkCharacters + serializedChunk.length <=
        FreeRouterObserver.maximumResponseChunkCharacters
    ) {
      request.responseChunks.push(structuredClone(value));
      request.capture.responseChunkCharacters += serializedChunk.length;
      this.#retainedCharacters += serializedChunk.length;
    } else {
      request.capture.responseChunks = "truncated";
    }
    if (isRecord(value.usage)) request.usage = value.usage;
    if (!Array.isArray(value.choices)) {
      this.#enforceRetention();
      return;
    }
    let derivedCharacters = 0;
    for (const choice of value.choices) {
      if (!isRecord(choice)) continue;
      const delta = isRecord(choice.delta)
        ? choice.delta
        : isRecord(choice.message)
        ? choice.message
        : null;
      if (!delta) continue;
      if (typeof delta.reasoning_content === "string") {
        const previousLength = request.reasoning.length;
        const appended = appendBounded(request.reasoning, delta.reasoning_content);
        request.reasoning = appended.value;
        derivedCharacters += Math.max(0, request.reasoning.length - previousLength);
        if (appended.truncated) request.capture.reasoning = "truncated";
      }
      if (typeof delta.reasoning === "string") {
        const previousLength = request.reasoning.length;
        const appended = appendBounded(request.reasoning, delta.reasoning);
        request.reasoning = appended.value;
        derivedCharacters += Math.max(0, request.reasoning.length - previousLength);
        if (appended.truncated) request.capture.reasoning = "truncated";
      }
      if (typeof delta.content === "string") {
        const previousLength = request.content.length;
        const appended = appendBounded(request.content, delta.content);
        request.content = appended.value;
        derivedCharacters += Math.max(0, request.content.length - previousLength);
        if (appended.truncated) request.capture.content = "truncated";
      }
    }
    this.#retainedCharacters += derivedCharacters;
    this.#enforceRetention();
  }

  fail(id: string, error: unknown): void {
    const request = this.#find(id);
    if (!request || request.status === "completed") return;
    request.status = "failed";
    request.updatedAt = new Date().toISOString();
    request.completedAt = request.updatedAt;
    request.error = error instanceof Error ? error.message : String(error);
    this.#persist(request);
  }

  snapshot(router: Record<string, unknown>, includeAudit = true): Record<string, unknown> {
    const requests = this.#requests.map((request) => {
      const copy = { ...request, routes: [...request.routes] };
      if (includeAudit) return copy;
      return {
        id: request.id,
        conversationId: request.conversationId,
        conversationSource: request.conversationSource,
        ...(request.conversationLabel ? { conversationLabel: request.conversationLabel } : {}),
        turnId: request.turnId,
        publicModel: request.publicModel,
        startedAt: request.startedAt,
        updatedAt: request.updatedAt,
        completedAt: request.completedAt,
        status: request.status,
        usage: request.usage,
        error: request.error,
      };
    });
    const active = requests.some((request) =>
      request.status === "routing" || request.status === "streaming"
    );
    const usage = requests.reduce(
      (total, request) => {
        total.inputTokens += usageNumber(request.usage, "prompt_tokens", "input_tokens");
        total.outputTokens += usageNumber(request.usage, "completion_tokens", "output_tokens");
        total.totalTokens += usageNumber(request.usage, "total_tokens");
        return total;
      },
      { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    );
    const last = requests.at(-1);
    return {
      configured: true,
      observer: { kind: "free-router", title: "Escape Velocity Shellie" },
      retention: {
        persistence: this.#journalPath
          ? "durable append-only JSONL; the bounded recent projection is replayed after router restarts and older records remain archived"
          : "memory-only; history resets when the router restarts",
        maximumRequests: this.#maximumRequests,
        maximumApproximateCharacters: this.#maximumRetainedCharacters,
        retainedRequests: requests.length,
        evictedRequests: this.#evictedRequests,
        journal: {
          enabled: Boolean(this.#journalPath),
          path: this.#journalPath ?? null,
          maximumBytes: this.#maximumJournalBytes,
          bytes: this.#journalLog?.bytes ?? 0,
          recordsLoaded: this.#journalRecordsLoaded,
          malformedRecords: this.#journalMalformedRecords,
        },
        excluded: [
          "HTTP request headers (apart from hashed conversation metadata)",
          "OMP and provider authentication state",
          "network-level transport details",
        ],
      },
      campaign: { usage, runs: requests.length },
      current: {
        id: last?.id ?? "Waiting for inference",
        phase: last?.publicModel ?? "free-router",
        status: active ? "running" : "idle",
      },
      events: [],
      stream: {
        lastEventAt: last?.updatedAt ?? null,
        bytes: this.#requests.reduce(
          (total, request) => total + request.reasoning.length + request.content.length,
          0,
        ),
        lastEventMethod: active ? "free-router/delta" : "free-router/completed",
      },
      inference: null,
      router,
      requests,
    };
  }

  #find(id: string): FreeRouterObservedRequest | undefined {
    return this.#requests.find((request) => request.id === id);
  }

  request(id: string): FreeRouterObservedRequest | undefined {
    const request = this.#find(id);
    return request ? structuredClone(request) : undefined;
  }

  conversation(
    id: string,
  ): Array<Record<string, unknown>> {
    return this.#requests.filter((request) => request.conversationId === id).map((request) => {
      const { requestBody: _requestBody, responseChunks: _responseChunks, ...summary } = request;
      return structuredClone({
        ...summary,
        audit: {
          available: true,
          messageCount: request.requestBody?.messages.length ?? 0,
          responseChunkCount: request.responseChunks.length,
        },
      });
    });
  }

  #enforceRetention(): void {
    while (
      this.#requests.length > this.#maximumRequests ||
      (this.#retainedCharacters > this.#maximumRetainedCharacters && this.#requests.length > 1)
    ) {
      const removed = this.#requests.shift();
      if (!removed) break;
      this.#retainedCharacters = Math.max(
        0,
        this.#retainedCharacters - observedRequestCharacters(removed),
      );
      this.#evictedRequests += 1;
    }
  }

  #restoreJournal(): void {
    if (!this.#journalPath) return;
    let text: string;
    try {
      text = readTextFileTailSync(this.#journalPath, this.#maximumRetainedCharacters);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return;
      throw error;
    }
    const restored = new Map<string, FreeRouterObservedRequest>();
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry?.version !== 1 || !isObservedRequest(entry.request)) {
          this.#journalMalformedRecords += 1;
          continue;
        }
        restored.set(entry.request.id, entry.request);
        this.#journalRecordsLoaded += 1;
      } catch {
        this.#journalMalformedRecords += 1;
      }
    }
    for (const request of restored.values()) {
      if (request.status === "routing" || request.status === "streaming") {
        request.status = "failed";
        request.completedAt = request.updatedAt;
        request.error =
          "Router restarted before this inference completed; live response data may be incomplete.";
        request.capture.responseChunks = "truncated";
      }
      this.#requests.push(request);
      this.#retainedCharacters += observedRequestCharacters(request);
    }
    this.#enforceRetention();
  }

  #persist(request: FreeRouterObservedRequest): void {
    if (!this.#journalLog) return;
    const line = JSON.stringify({ version: 1, request: structuredClone(request) }) + "\n";
    this.#journalPending = this.#journalPending.then(() => this.#journalLog?.append(line)).catch(
      (error) => {
        if (error instanceof TextLogCapacityError) throw error;
        console.error(`Could not persist free-router audit journal: ${error}`);
      },
    );
  }

  async flush(): Promise<void> {
    await this.#journalPending;
  }
}

function readTextFileTailSync(path: string, maximumBytes: number): string {
  const file = Deno.openSync(path, { read: true });
  try {
    const size = file.statSync().size;
    const start = Math.max(0, size - maximumBytes);
    file.seekSync(start, Deno.SeekMode.Start);
    const bytes = new Uint8Array(size - start);
    let offset = 0;
    while (offset < bytes.length) {
      const read = file.readSync(bytes.subarray(offset));
      if (read === null) break;
      offset += read;
    }
    let text = new TextDecoder().decode(bytes.subarray(0, offset));
    if (start > 0) {
      const firstNewline = text.indexOf("\n");
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
    }
    return text;
  } finally {
    file.close();
  }
}

function isObservedRequest(value: unknown): value is FreeRouterObservedRequest {
  if (!isRecord(value) || !isRecord(value.capture)) return false;
  return typeof value.id === "string" && typeof value.conversationId === "string" &&
    typeof value.turnId === "string" && typeof value.publicModel === "string" &&
    typeof value.startedAt === "string" && Array.isArray(value.routes) &&
    Array.isArray(value.responseChunks);
}

async function observerConversation(
  request: Request,
): Promise<{ id: string; source: string }> {
  const rawId = request.headers.get("x-lm-tools-conversation-id")?.trim().slice(0, 512);
  const rawSource = request.headers.get("x-lm-tools-conversation-source")?.trim().slice(0, 64);
  const source = rawSource?.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") ||
    "agent";
  return { id: await observerOpaqueId(rawId, "chat", "unattributed"), source };
}

async function observerOpaqueId(
  rawValue: string | null | undefined,
  prefix: string,
  fallback: string,
): Promise<string> {
  const value = rawValue?.trim().slice(0, 512);
  if (!value) return fallback;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const shortHash = [...new Uint8Array(digest)]
    .slice(0, 8)
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  return `${prefix}-${shortHash}`;
}

function latestUserMessage(messages: unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message) || message.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    if (!Array.isArray(message.content)) return "";
    return message.content
      .flatMap((part) => {
        if (typeof part === "string") return [part];
        if (!isRecord(part)) return [];
        if (typeof part.text === "string") return [part.text];
        if (part.type === "image_url" || part.type === "input_image") return ["[image]"];
        return [];
      })
      .join("\n");
  }
  return "";
}

function appendBounded(current: string, delta: string): { value: string; truncated: boolean } {
  const maximum = FreeRouterObserver.maximumFieldCharacters;
  const next = current + delta;
  if (next.length <= maximum) return { value: next, truncated: false };
  return { value: next.slice(-maximum), truncated: true };
}

function observedRequestCharacters(request: FreeRouterObservedRequest): number {
  return (request.requestBody
    ? JSON.stringify(request.requestBody).length
    : request.userMessage.length) +
    request.capture.responseChunkCharacters + request.reasoning.length + request.content.length;
}

function usageNumber(
  usage: Record<string, unknown> | undefined,
  ...names: string[]
): number {
  for (const name of names) {
    const value = usage?.[name];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
}

interface ActiveRouteStatus {
  offer: FreeRouteOffer;
  requests: number;
  since: string;
}

function publicOffer(offer: FreeRouteOffer): Record<string, unknown> {
  return {
    id: offer.id,
    ...(offer.publicModel ? { publicModel: offer.publicModel } : {}),
    provider: offer.provider,
    model: offer.model,
    accessClass: offer.accessClass,
    priority: offer.priority ?? 0,
  };
}

class FreeRouterStatus {
  readonly startedAt = new Date().toISOString();
  readonly #active = new Map<string, ActiveRouteStatus>();
  #lastCompleted?: { offer: FreeRouteOffer; at: string };
  #recentFailures: Array<{ offer: FreeRouteOffer; kind: string; at: string }> = [];

  observe(event: RouterAttemptEvent): void {
    const now = new Date().toISOString();
    const activeKey = `${event.offer.publicModel ?? ""}\0${event.offer.id}`;
    if (event.type === "attempt") {
      const active = this.#active.get(activeKey);
      if (active) active.requests++;
      else {
        this.#active.set(activeKey, {
          offer: event.offer,
          requests: 1,
          since: now,
        });
      }
      return;
    }
    const active = this.#active.get(activeKey);
    if (event.type === "committed") return;
    if (event.type === "completed") this.#lastCompleted = { offer: event.offer, at: now };
    if (event.type === "failure") {
      this.#recentFailures.unshift({
        offer: event.offer,
        kind: event.failure?.kind ?? "unknown",
        at: now,
      });
      this.#recentFailures.length = Math.min(this.#recentFailures.length, 8);
    }
    if (!active) return;
    active.requests--;
    if (active.requests <= 0) this.#active.delete(activeKey);
  }

  snapshot(
    models: ReadonlyMap<string, FreeRouterModelConfig>,
    router: FreeRouter<OpenAIChatCompletionRequest, OmpGatewayEvent>,
  ): Record<string, unknown> {
    const active = Array.from(this.#active.values()).map((route) => ({
      ...publicOffer(route.offer),
      requests: route.requests,
      since: route.since,
    }));
    return {
      status: active.length > 0 ? "active" : "idle",
      startedAt: this.startedAt,
      active,
      lastCompleted: this.#lastCompleted
        ? { ...publicOffer(this.#lastCompleted.offer), at: this.#lastCompleted.at }
        : null,
      routes: Array.from(models.values()).flatMap((model) =>
        model.offers.map((offer) => {
          const cooldownRemainingMs = router.cooldowns.remainingMs(offer);
          const rejection = rejectOffer(offer, router.policy);
          return {
            publicModel: model.id,
            ...publicOffer(offer),
            state: rejection ? "ineligible" : cooldownRemainingMs > 0 ? "cooldown" : "ready",
            cooldownRemainingMs,
            ...(rejection ? { rejection } : {}),
          };
        })
      ),
      recentFailures: this.#recentFailures.map((failure) => ({
        ...publicOffer(failure.offer),
        kind: failure.kind,
        at: failure.at,
      })),
    };
  }
}

function eligibleModelIds(
  models: ReadonlyMap<string, FreeRouterModelConfig>,
  router: FreeRouter<OpenAIChatCompletionRequest, OmpGatewayEvent>,
): string[] {
  return eligibleModels(models, router).map((model) => model.id);
}

function eligibleModels(
  models: ReadonlyMap<string, FreeRouterModelConfig>,
  router: FreeRouter<OpenAIChatCompletionRequest, OmpGatewayEvent>,
): FreeRouterModelConfig[] {
  return Array.from(models.values()).filter((model) => router.eligible(model.offers).length > 0);
}

function encodeOpenAIStream(
  first: OmpGatewayEvent,
  iterator: AsyncIterator<OmpGatewayEvent>,
  publicModel: string,
  onEvent: (event: Record<string, unknown>) => void,
  observer: FreeRouterObserver,
  requestId: string,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      try {
        for (
          let next: IteratorResult<OmpGatewayEvent> = { value: first, done: false };
          !next.done;
          next = await iterator.next()
        ) {
          const event = next.value;
          if (event.type === "done") continue;
          const value = rewriteModel(event.value, publicModel);
          observer.observeChunk(requestId, value);
          observeUsage(value, publicModel, onEvent);
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (error) {
        observer.fail(requestId, error);
        controller.error(error);
      }
    },
    cancel(reason) {
      return iterator.return?.(reason).then(() => undefined);
    },
  });
}

async function collectCompletion(
  publicModel: string,
  first: OmpGatewayEvent,
  iterator: AsyncIterator<OmpGatewayEvent>,
  onEvent: (event: Record<string, unknown>) => void,
  observer: FreeRouterObserver,
  requestId: string,
): Promise<Record<string, unknown>> {
  let id = `chatcmpl-${crypto.randomUUID()}`;
  let created = Math.floor(Date.now() / 1000);
  let usage: unknown;
  const choices = new Map<
    number,
    {
      role: string;
      content: string;
      reasoning_content: string;
      tool_calls: Map<number, Record<string, unknown>>;
      finish_reason: unknown;
    }
  >();
  for (
    let next: IteratorResult<OmpGatewayEvent> = { value: first, done: false };
    !next.done;
    next = await iterator.next()
  ) {
    if (next.value.type === "done" || !isRecord(next.value.value)) continue;
    const chunk = next.value.value;
    observer.observeChunk(requestId, chunk);
    if (typeof chunk.id === "string") id = chunk.id;
    if (typeof chunk.created === "number") created = chunk.created;
    if (chunk.usage !== undefined) usage = chunk.usage;
    if (!Array.isArray(chunk.choices)) continue;
    for (const candidate of chunk.choices) {
      if (!isRecord(candidate)) continue;
      const index = typeof candidate.index === "number" ? candidate.index : 0;
      const choice = choices.get(index) ??
        {
          role: "assistant",
          content: "",
          reasoning_content: "",
          tool_calls: new Map(),
          finish_reason: null,
        };
      if (isRecord(candidate.delta)) {
        if (typeof candidate.delta.role === "string") choice.role = candidate.delta.role;
        if (typeof candidate.delta.content === "string") choice.content += candidate.delta.content;
        if (typeof candidate.delta.reasoning_content === "string") {
          choice.reasoning_content += candidate.delta.reasoning_content;
        }
        if (Array.isArray(candidate.delta.tool_calls)) {
          for (const [fallbackIndex, toolCall] of candidate.delta.tool_calls.entries()) {
            mergeToolCallDelta(choice.tool_calls, toolCall, fallbackIndex);
          }
        }
      }
      if (candidate.finish_reason !== undefined) choice.finish_reason = candidate.finish_reason;
      choices.set(index, choice);
    }
  }
  const responseChoices = Array.from(choices.entries()).sort(([left], [right]) => left - right).map(
    ([index, choice]) => {
      const message: Record<string, unknown> = {
        role: choice.role,
        content: choice.content || null,
      };
      if (choice.reasoning_content) message.reasoning_content = choice.reasoning_content;
      if (choice.tool_calls.size > 0) {
        message.tool_calls = Array.from(choice.tool_calls.entries())
          .sort(([left], [right]) => left - right)
          .map(([, toolCall]) => toolCall);
      }
      return { index, message, finish_reason: choice.finish_reason };
    },
  );
  const response: Record<string, unknown> = {
    id,
    object: "chat.completion",
    created,
    model: publicModel,
    choices: responseChoices,
  };
  if (usage !== undefined) response.usage = usage;
  observeUsage(response, publicModel, onEvent);
  return response;
}

function mergeToolCallDelta(
  calls: Map<number, Record<string, unknown>>,
  value: unknown,
  fallbackIndex: number,
): void {
  if (!isRecord(value)) return;
  const index = typeof value.index === "number" ? value.index : fallbackIndex;
  const current = calls.get(index) ?? {};
  for (const [key, field] of Object.entries(value)) {
    if (key === "index" || key === "function") continue;
    if (field !== null && field !== undefined) current[key] = field;
  }
  if (isRecord(value.function)) {
    const currentFunction = isRecord(current.function) ? current.function : {};
    for (const [key, field] of Object.entries(value.function)) {
      if (key === "arguments" && typeof field === "string") {
        currentFunction.arguments = `${
          typeof currentFunction.arguments === "string" ? currentFunction.arguments : ""
        }${field}`;
      } else if (field !== null && field !== undefined) {
        currentFunction[key] = field;
      }
    }
    current.function = currentFunction;
  }
  calls.set(index, current);
}

function rewriteModel(value: unknown, publicModel: string): unknown {
  return isRecord(value) ? { ...value, model: publicModel } : value;
}

function observeUsage(
  value: unknown,
  publicModel: string,
  onEvent: (event: Record<string, unknown>) => void,
): void {
  if (isRecord(value) && isRecord(value.usage)) {
    onEvent({ type: "usage", model: publicModel, usage: value.usage });
  }
}

function logRouterEvent(event: RouterAttemptEvent | Record<string, unknown>): void {
  const record = event as RouterAttemptEvent;
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    component: "lm-tools-free-router",
    ...event,
    ...(record.offer ? { offer: { ...record.offer, pricing: record.offer.pricing } } : {}),
  }));
}

function routerErrorResponse(error: unknown): Response {
  if (error instanceof NoFreeRouteError) {
    return json(503, { error: { type: "no_free_route", message: error.message } });
  }
  const message = error instanceof Error ? error.message : "Free inference request failed";
  return json(502, { error: { type: "upstream_error", message } });
}

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
