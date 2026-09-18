import {
  FreeAccessAdapter,
  FreeAccessError,
  FreeRouteOffer,
  NormalizedAccessEvent,
} from "./free_router.ts";

export interface OpenAIChatCompletionRequest {
  model?: string;
  messages: unknown[];
  [key: string]: unknown;
}

export interface OmpGatewayModel {
  id: string;
  owned_by: string;
  api?: string;
  display_name?: string;
  context_length?: number;
  max_output_tokens?: number;
  input_modalities?: string[];
  supports_tools?: boolean;
}

export interface OmpGatewayEvent extends NormalizedAccessEvent {
  type: "chunk" | "done";
  value?: unknown;
}

export interface OmpGatewayAdapterOptions {
  /** Root URL of `omp auth-gateway serve`, without `/v1`. */
  baseUrl: string;
  /** Gateway bearer only. Provider credentials remain inside OMP. */
  bearerToken?: string;
  adapterId?: string;
  fetch?: typeof fetch;
}

/**
 * Streaming transport for OMP's auth-gateway.
 *
 * This deliberately contains no provider login, key discovery, or refresh
 * logic. OMP owns those concerns; lm-tools sends only a provider-qualified
 * model id and an OpenAI-compatible request.
 */
export class OmpGatewayAdapter
  implements FreeAccessAdapter<OpenAIChatCompletionRequest, OmpGatewayEvent> {
  readonly id: string;
  readonly #baseUrl: string;
  readonly #bearerToken?: string;
  readonly #fetch: typeof fetch;

  constructor(options: OmpGatewayAdapterOptions) {
    this.id = options.adapterId ?? "omp";
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#bearerToken = options.bearerToken;
    this.#fetch = options.fetch ?? fetch;
    if (!/^https?:\/\//.test(this.#baseUrl)) {
      throw new Error("OMP gateway baseUrl must be an http(s) URL");
    }
  }

  async listModels(signal?: AbortSignal): Promise<OmpGatewayModel[]> {
    const response = await this.#request("/v1/models", { method: "GET", signal });
    if (!response.ok) throw await this.#responseError(response);
    const body = await response.json();
    if (!isRecord(body) || !Array.isArray(body.data)) {
      throw new FreeAccessError({
        kind: "unavailable",
        message: "OMP returned an invalid model list",
      });
    }
    return body.data.filter(isGatewayModel);
  }

  async *stream(
    offer: FreeRouteOffer,
    request: OpenAIChatCompletionRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<OmpGatewayEvent> {
    const model = offer.model.startsWith(`${offer.provider}/`)
      ? offer.model
      : `${offer.provider}/${offer.model}`;

    let response: Response;
    try {
      const streamOptions = isRecord(request.stream_options) ? request.stream_options : {};
      response = await this.#request("/v1/chat/completions", {
        method: "POST",
        signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...request,
          model,
          stream: true,
          stream_options: { ...streamOptions, include_usage: true },
        }),
      });
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      throw new FreeAccessError({
        kind: "unavailable",
        message: error instanceof Error ? error.message : "Could not reach OMP auth-gateway",
        cause: error,
      });
    }

    if (!response.ok) throw await this.#responseError(response);
    if (!response.body) {
      throw new FreeAccessError({ kind: "unavailable", message: "OMP returned an empty stream" });
    }

    for await (const data of decodeServerSentEvents(response.body)) {
      if (data === "[DONE]") {
        yield { type: "done", commitsOutput: false };
        continue;
      }

      let value: unknown;
      try {
        value = JSON.parse(data);
      } catch (error) {
        throw new FreeAccessError({
          kind: "unavailable",
          message: "OMP returned malformed streaming JSON",
          cause: error,
        });
      }
      if (isRecord(value) && value.error !== undefined) {
        throw gatewayEnvelopeError(value.error);
      }
      yield { type: "chunk", commitsOutput: chunkCommitsOutput(value), value };
    }
  }

  #request(path: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json, text/event-stream");
    headers.set("x-omp-app", "lm-tools");
    if (this.#bearerToken) headers.set("authorization", `Bearer ${this.#bearerToken}`);
    return this.#fetch(`${this.#baseUrl}${path}`, { ...init, headers });
  }

  async #responseError(response: Response): Promise<FreeAccessError> {
    const body = await readResponseBody(response, 64 * 1024);
    const message = redactSecret(
      extractErrorMessage(body) ?? `OMP gateway returned HTTP ${response.status}`,
      this.#bearerToken,
    );
    return new FreeAccessError({
      kind: classifyStatus(response.status, message),
      message,
      retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
    });
  }
}

export async function* decodeServerSentEvents(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let dataLines: string[] = [];

  const consumeLine = (rawLine: string): string | undefined => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line === "") {
      if (dataLines.length === 0) return undefined;
      const event = dataLines.join("\n");
      dataLines = [];
      return event;
    }
    if (line.startsWith("data:")) {
      const value = line.slice(5);
      dataLines.push(value.startsWith(" ") ? value.slice(1) : value);
    }
    return undefined;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        const event = consumeLine(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        if (event !== undefined) yield event;
      }
    }
    buffered += decoder.decode();
    if (buffered.length > 0) {
      const event = consumeLine(buffered);
      if (event !== undefined) yield event;
    }
    if (dataLines.length > 0) yield dataLines.join("\n");
  } finally {
    reader.releaseLock();
  }
}

function chunkCommitsOutput(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.choices)) return false;
  return value.choices.some((choice) => {
    if (!isRecord(choice)) return false;
    if (typeof choice.text === "string" && choice.text.length > 0) return true;
    if (!isRecord(choice.delta)) return false;
    const delta = choice.delta;
    return (typeof delta.content === "string" && delta.content.length > 0) ||
      (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) ||
      (typeof delta.reasoning === "string" && delta.reasoning.length > 0) ||
      (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) ||
      isRecord(delta.function_call);
  });
}

function gatewayEnvelopeError(error: unknown): FreeAccessError {
  const message = isRecord(error) && typeof error.message === "string"
    ? error.message
    : "OMP returned a streaming error";
  const status = isRecord(error) && typeof error.status === "number" ? error.status : 500;
  return new FreeAccessError({ kind: classifyStatus(status, message), message });
}

function classifyStatus(status: number, message: string) {
  if (status === 401 || status === 403) return "auth" as const;
  if (status === 402 || /\b(quota|credit|billing|insufficient)\b/i.test(message)) {
    return "quota" as const;
  }
  if (status === 429) return "rate-limit" as const;
  if (status === 400 || status === 404 || status === 405 || status === 422) {
    return "invalid-request" as const;
  }
  if (status === 408 || status >= 500) return "unavailable" as const;
  return "unknown" as const;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return undefined;
  return Math.max(0, date - Date.now());
}

async function readResponseBody(response: Response, limit: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let result = "";
  try {
    while (result.length < limit) {
      const { value, done } = await reader.read();
      if (done) break;
      result += decoder.decode(value, { stream: true });
    }
    result += decoder.decode();
    return result.slice(0, limit);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function extractErrorMessage(body: string): string | undefined {
  if (!body) return undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    if (isRecord(parsed) && typeof parsed.error === "string") return parsed.error;
    if (isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.message === "string") {
      return parsed.error.message;
    }
    if (isRecord(parsed) && typeof parsed.message === "string") return parsed.message;
  } catch {
    // Do not reflect an arbitrary HTML/body response into logs or clients.
  }
  return undefined;
}

function redactSecret(message: string, secret?: string): string {
  return secret ? message.replaceAll(secret, "[redacted]") : message;
}

function isGatewayModel(value: unknown): value is OmpGatewayModel {
  return isRecord(value) && typeof value.id === "string" && typeof value.owned_by === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
