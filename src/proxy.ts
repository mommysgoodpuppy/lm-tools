import { parsePort, takeValue } from "./args.ts";
import { defaultDiagnosticLog, type DiagnosticLog } from "./log.ts";

const DEFAULT_LISTEN_HOST = "0.0.0.0";
const DEFAULT_LISTEN_PORT = 1235;
const DEFAULT_UPSTREAM = "http://127.0.0.1:8080";

export interface NormalizationResult {
  body: unknown;
  fixes: number;
  changes: string[];
}

type JsonObject = Record<string, unknown>;

export interface PromptEvaluationProgress {
  taskId: number;
  tokens: number;
  progress: number;
}

export interface PromptProgressSource {
  reset(): void;
  read(): PromptEvaluationProgress | undefined;
}

function wantsVscodeReasoningCompatibility(body: unknown): boolean {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return false;
  const include = (body as JsonObject).include;
  return Array.isArray(include) && include.includes("reasoning.encrypted_content");
}

function reasoningSummary(text: string): JsonObject {
  return { type: "summary_text", text };
}

export function adaptReasoningEvent(event: JsonObject): JsonObject {
  const type = event.type;
  if (type === "response.reasoning_text.delta" || type === "response.reasoning_text.done") {
    const { content_index: _contentIndex, ...rest } = event;
    const suffix = type.endsWith(".delta") ? "delta" : "done";
    return { ...rest, type: `response.reasoning_summary_text.${suffix}`, summary_index: 0 };
  }

  if (type === "response.content_part.added" || type === "response.content_part.done") {
    const part = event.part;
    if (part !== null && typeof part === "object" && !Array.isArray(part)) {
      const reasoningPart = part as JsonObject;
      if (reasoningPart.type === "reasoning_text") {
        const { content_index: _contentIndex, ...rest } = event;
        const suffix = type.endsWith(".added") ? "added" : "done";
        return {
          ...rest,
          type: `response.reasoning_summary_part.${suffix}`,
          summary_index: 0,
          part: reasoningSummary(typeof reasoningPart.text === "string" ? reasoningPart.text : ""),
        };
      }
    }
  }

  if (type === "response.output_item.done") {
    const item = event.item;
    if (item !== null && typeof item === "object" && !Array.isArray(item)) {
      const reasoningItem = item as JsonObject;
      if (reasoningItem.type === "reasoning" && Array.isArray(reasoningItem.content)) {
        return { ...event, item: withReasoningSummary(reasoningItem) };
      }
    }
  }

  if (type === "response.completed" || type === "response.incomplete") {
    const response = event.response;
    if (response !== null && typeof response === "object" && !Array.isArray(response)) {
      const responseObject = response as JsonObject;
      if (Array.isArray(responseObject.output)) {
        return {
          ...event,
          response: {
            ...responseObject,
            output: responseObject.output.map((item) =>
              item !== null && typeof item === "object" && !Array.isArray(item) &&
                (item as JsonObject).type === "reasoning"
                ? withReasoningSummary(item as JsonObject)
                : item
            ),
          },
        };
      }
    }
  }
  return event;
}

function withReasoningSummary(item: JsonObject): JsonObject {
  const content = Array.isArray(item.content) ? item.content : [];
  const text = content
    .filter((part): part is JsonObject =>
      part !== null && typeof part === "object" && !Array.isArray(part)
    )
    .filter((part) => part.type === "reasoning_text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("");
  return { ...item, summary: [reasoningSummary(text)] };
}

interface ReasoningStreamItem {
  itemId: string;
  outputIndex: number;
  text: string;
  partAdded: boolean;
  textDone: boolean;
}

interface ReasoningStreamState {
  items: Map<string, ReasoningStreamItem>;
  promptTrace?: {
    itemId: string;
    active: boolean;
    lastProgress: number;
    text: string;
  };
}

type SystemReasoningKind = "prompt-evaluation";

function systemReasoningItemId(kind: SystemReasoningKind): string {
  return `lm-tools-system-reasoning-${kind}-${crypto.randomUUID()}`;
}

function isSystemReasoningItem(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const id = (value as JsonObject).id;
  return typeof id === "string" &&
    (id.startsWith("lm-tools-system-reasoning-") || id.startsWith("lm-tools-prompt-"));
}

function stripSystemReasoningPrefix(text: string): string {
  return text.replace(
    /^(?:Evaluating prompt…(?:\r?\n|$))(?:Prompt evaluation: [^\r\n]*(?:\r?\n|$))*/,
    "",
  );
}

function sanitizeSystemReasoning(value: unknown): { value: unknown; fixes: number } {
  if (typeof value === "string") {
    const sanitized = stripSystemReasoningPrefix(value);
    return { value: sanitized, fixes: sanitized === value ? 0 : 1 };
  }
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    let fixes = 0;
    for (const item of value) {
      if (isSystemReasoningItem(item)) {
        fixes++;
        continue;
      }
      const sanitized = sanitizeSystemReasoning(item);
      output.push(sanitized.value);
      fixes += sanitized.fixes;
    }
    return { value: fixes === 0 ? value : output, fixes };
  }
  if (value !== null && typeof value === "object") {
    let fixes = 0;
    const output: JsonObject = {};
    for (const [key, item] of Object.entries(value as JsonObject)) {
      const sanitized = sanitizeSystemReasoning(item);
      output[key] = sanitized.value;
      fixes += sanitized.fixes;
    }
    return { value: fixes === 0 ? value : output, fixes };
  }
  return { value, fixes: 0 };
}

function syntheticSseBlock(event: JsonObject): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function reasoningPartEvent(
  type: "response.reasoning_summary_part.added" | "response.reasoning_summary_part.done",
  item: ReasoningStreamItem,
): JsonObject {
  return {
    type,
    item_id: item.itemId,
    output_index: item.outputIndex,
    summary_index: 0,
    part: reasoningSummary(type.endsWith(".done") ? item.text : ""),
  };
}

function finishPromptTrace(state: ReasoningStreamState): string {
  const trace = state.promptTrace;
  if (!trace?.active) return "";
  trace.active = false;
  const item = {
    id: trace.itemId,
    type: "reasoning",
    status: "completed",
    summary: [reasoningSummary(trace.text)],
  };
  return [
    {
      type: "response.reasoning_summary_text.done",
      item_id: trace.itemId,
      output_index: -1,
      summary_index: 0,
      text: trace.text,
    },
    {
      type: "response.reasoning_summary_part.done",
      item_id: trace.itemId,
      output_index: -1,
      summary_index: 0,
      part: reasoningSummary(trace.text),
    },
    { type: "response.output_item.done", output_index: -1, item },
  ].map(syntheticSseBlock).join("");
}

function adaptSseBlock(
  block: string,
  state: ReasoningStreamState,
  observe?: (event: JsonObject) => void,
): string {
  const lines = block.split(/\r?\n/);
  const dataIndex = lines.findIndex((line) => line.startsWith("data: "));
  if (dataIndex === -1) return `${block}\n\n`;
  try {
    const event = JSON.parse(lines[dataIndex].slice(6)) as JsonObject;
    observe?.(event);
    const type = event.type;
    const itemId = typeof event.item_id === "string" ? event.item_id : undefined;
    let prefix = "";

    if (
      type === "response.reasoning_text.delta" ||
      type === "response.output_text.delta" ||
      type === "response.function_call_arguments.delta" ||
      type === "response.completed" ||
      type === "response.incomplete" ||
      type === "error"
    ) {
      prefix += finishPromptTrace(state);
    }

    if (type === "response.output_item.added") {
      const item = event.item;
      if (item !== null && typeof item === "object" && !Array.isArray(item)) {
        const reasoningItem = item as JsonObject;
        if (reasoningItem.type === "reasoning" && typeof reasoningItem.id === "string") {
          state.items.set(reasoningItem.id, {
            itemId: reasoningItem.id,
            outputIndex: typeof event.output_index === "number" ? event.output_index : 0,
            text: "",
            partAdded: false,
            textDone: false,
          });
        }
      }
    }

    if (type === "response.reasoning_text.delta" && itemId) {
      const item = state.items.get(itemId);
      if (item) {
        if (!item.partAdded) {
          prefix += syntheticSseBlock(
            reasoningPartEvent("response.reasoning_summary_part.added", item),
          );
          item.partAdded = true;
        }
        if (typeof event.delta === "string") item.text += event.delta;
      }
    }

    if (type === "response.reasoning_text.done" && itemId) {
      const item = state.items.get(itemId);
      if (item) {
        if (!item.partAdded) {
          prefix += syntheticSseBlock(
            reasoningPartEvent("response.reasoning_summary_part.added", item),
          );
          item.partAdded = true;
        }
        if (typeof event.text === "string") item.text = event.text;
        item.textDone = true;
      }
    }

    if (type === "response.output_item.done") {
      const doneItem = event.item;
      const doneItemId =
        doneItem !== null && typeof doneItem === "object" && !Array.isArray(doneItem)
          ? (doneItem as JsonObject).id
          : undefined;
      const item = typeof doneItemId === "string" ? state.items.get(doneItemId) : undefined;
      if (item) {
        if (!item.partAdded) {
          prefix += syntheticSseBlock(
            reasoningPartEvent("response.reasoning_summary_part.added", item),
          );
        }
        if (!item.textDone) {
          prefix += syntheticSseBlock({
            type: "response.reasoning_summary_text.done",
            item_id: item.itemId,
            output_index: item.outputIndex,
            summary_index: 0,
            text: item.text,
          });
        }
        prefix += syntheticSseBlock(
          reasoningPartEvent("response.reasoning_summary_part.done", item),
        );
        state.items.delete(item.itemId);
      }
    }

    const adapted = adaptReasoningEvent(event);
    if (adapted === event) return `${prefix}${block}\n\n`;
    lines[dataIndex] = `data: ${JSON.stringify(adapted)}`;
    const eventIndex = lines.findIndex((line) => line.startsWith("event: "));
    if (eventIndex !== -1 && typeof adapted.type === "string") {
      lines[eventIndex] = `event: ${adapted.type}`;
    }
    return `${prefix}${lines.join("\n")}\n\n`;
  } catch {
    return `${block}\n\n`;
  }
}

export function adaptReasoningStream(
  body: ReadableStream<Uint8Array>,
  promptProgress?: () => PromptEvaluationProgress | undefined,
  observe?: (event: JsonObject) => void,
): ReadableStream<Uint8Array> {
  let buffered = "";
  const state: ReasoningStreamState = {
    items: new Map(),
    promptTrace: promptProgress
      ? {
        itemId: systemReasoningItemId("prompt-evaluation"),
        active: true,
        lastProgress: -1,
        text: "Evaluating prompt…\n",
      }
      : undefined,
  };
  let timer: ReturnType<typeof setInterval> | undefined;
  return body.pipeThrough(new TextDecoderStream()).pipeThrough(
    new TransformStream<string, string>({
      start(controller) {
        const trace = state.promptTrace;
        if (!trace || !promptProgress) return;
        const item = {
          id: trace.itemId,
          type: "reasoning",
          status: "in_progress",
          summary: [],
        };
        controller.enqueue(
          [
            { type: "response.output_item.added", output_index: -1, item },
            {
              type: "response.reasoning_summary_part.added",
              item_id: trace.itemId,
              output_index: -1,
              summary_index: 0,
              part: reasoningSummary(""),
            },
            {
              type: "response.reasoning_summary_text.delta",
              item_id: trace.itemId,
              output_index: -1,
              summary_index: 0,
              delta: trace.text,
            },
          ].map(syntheticSseBlock).join(""),
        );
        timer = setInterval(() => {
          try {
            const current = promptProgress();
            if (!trace.active || !current || current.progress <= trace.lastProgress) return;
            trace.lastProgress = current.progress;
            const percent = Math.min(100, Math.max(0, Math.round(current.progress * 100)));
            const delta = `Prompt evaluation: ${percent}% (${
              current.tokens.toLocaleString("en-US")
            } tokens)\n`;
            trace.text += delta;
            controller.enqueue(syntheticSseBlock({
              type: "response.reasoning_summary_text.delta",
              item_id: trace.itemId,
              output_index: -1,
              summary_index: 0,
              delta,
            }));
          } catch {
            if (timer !== undefined) clearInterval(timer);
          }
        }, 250);
      },
      transform(chunk, controller) {
        buffered += chunk.replaceAll("\r\n", "\n");
        let boundary: number;
        while ((boundary = buffered.indexOf("\n\n")) !== -1) {
          controller.enqueue(adaptSseBlock(buffered.slice(0, boundary), state, observe));
          buffered = buffered.slice(boundary + 2);
        }
      },
      flush(controller) {
        if (timer !== undefined) clearInterval(timer);
        const ending = finishPromptTrace(state);
        if (ending) controller.enqueue(ending);
        if (buffered.length > 0) controller.enqueue(buffered);
      },
    }),
  ).pipeThrough(new TextEncoderStream());
}

function isEmptyObject(value: unknown): value is Record<string, never> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === 0;
}

function messageText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const part of content) {
    if (part === null || typeof part !== "object" || Array.isArray(part)) return undefined;
    const item = part as JsonObject;
    if (item.type !== "input_text" || typeof item.text !== "string") return undefined;
    parts.push(item.text);
  }
  return parts.join("\n\n");
}

function foldLeadingDeveloperMessages(request: JsonObject): {
  request: JsonObject;
  fixes: number;
} {
  if (!Array.isArray(request.input)) return { request, fixes: 0 };
  const developerText: string[] = [];
  let count = 0;
  for (const value of request.input) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) break;
    const message = value as JsonObject;
    if (message.type !== "message" || message.role !== "developer") break;
    const text = messageText(message.content);
    if (text === undefined) break;
    developerText.push(text);
    count++;
  }
  if (count === 0) return { request, fixes: 0 };
  const existing = typeof request.instructions === "string" ? request.instructions : "";
  return {
    request: {
      ...request,
      instructions: [existing, ...developerText].filter(Boolean).join("\n\n"),
      input: request.input.slice(count),
    },
    fixes: count,
  };
}

export function normalizeRequestBody(
  body: unknown,
  reasoningEffortMap: Record<string, string> = {},
): NormalizationResult {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { body, fixes: 0, changes: [] };
  }
  const request = body as JsonObject;
  let fixes = 0;
  const changes: string[] = [];
  let normalized = request;

  const reasoning = request.reasoning;
  if (reasoning !== null && typeof reasoning === "object" && !Array.isArray(reasoning)) {
    const effort = (reasoning as JsonObject).effort;
    if (typeof effort === "string") {
      const wireEffort = reasoningEffortMap[effort] ?? effort;
      if (wireEffort !== "none") {
        const existing = request.chat_template_kwargs;
        const chatTemplateKwargs = existing !== null && typeof existing === "object" &&
            !Array.isArray(existing)
          ? existing as JsonObject
          : {};
        normalized = {
          ...normalized,
          reasoning: { ...(reasoning as JsonObject), effort: wireEffort },
          chat_template_kwargs: { ...chatTemplateKwargs, reasoning_effort: wireEffort },
        };
        fixes++;
        changes.push(`mapped reasoning effort ${effort} to template value ${wireEffort}`);
      }
    }
  }

  if (Object.hasOwn(request, "previous_response_id")) {
    const { previous_response_id: _previousResponseId, ...withoutPreviousResponseId } = normalized;
    normalized = withoutPreviousResponseId;
    fixes++;
    changes.push("removed previous_response_id");
  }

  if (Object.hasOwn(request, "input")) {
    const sanitized = sanitizeSystemReasoning(normalized.input);
    if (sanitized.fixes > 0) {
      normalized = { ...normalized, input: sanitized.value };
      fixes += sanitized.fixes;
      changes.push(`removed ${sanitized.fixes} system reasoning trace artifact(s)`);
    }
  }

  const folded = foldLeadingDeveloperMessages(normalized);
  if (folded.fixes > 0) {
    normalized = folded.request;
    fixes += folded.fixes;
    changes.push(`folded ${folded.fixes} leading developer message(s) into instructions`);
  }

  if (Array.isArray(request.tools)) {
    let toolFixes = 0;
    const tools = request.tools.map((tool) => {
      if (tool === null || typeof tool !== "object" || Array.isArray(tool)) return tool;
      const functionTool = tool as JsonObject;
      if (functionTool.type !== "function" || !isEmptyObject(functionTool.parameters)) return tool;
      fixes++;
      toolFixes++;
      return {
        ...functionTool,
        parameters: { type: "object", properties: {}, additionalProperties: false },
      };
    });
    if (toolFixes > 0) {
      normalized = { ...normalized, tools };
      changes.push(`normalized ${toolFixes} empty tool schema(s)`);
    }
  }
  return fixes === 0 ? { body, fixes: 0, changes } : { body: normalized, fixes, changes };
}

export interface ProxyOptions {
  listenHost: string;
  listenPort: number;
  upstream: URL;
  promptProgress?: PromptProgressSource;
  reasoningEffortMap?: Record<string, string>;
  diagnostics?: DiagnosticLog;
}

export function proxyUsage(): string {
  return `Usage: lm proxy [options]

Options:
  --listen-host HOST  Address to listen on (default: ${DEFAULT_LISTEN_HOST})
  --listen-port PORT  Port to listen on (default: ${DEFAULT_LISTEN_PORT})
  --upstream URL      OpenAI-compatible server (default: ${DEFAULT_UPSTREAM})
  --help              Show this help

The proxy has no authentication. Do not expose it to an untrusted network.`;
}

function parseProxyArgs(args: string[]): ProxyOptions {
  const options = {
    listenHost: DEFAULT_LISTEN_HOST,
    listenPort: DEFAULT_LISTEN_PORT,
    upstream: new URL(DEFAULT_UPSTREAM),
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") throw new ProxyHelp(proxyUsage());
    const value = takeValue(args, index, arg);
    index++;
    if (arg === "--listen-host") options.listenHost = value;
    else if (arg === "--listen-port") options.listenPort = parsePort(value, arg);
    else if (arg === "--upstream") options.upstream = new URL(value);
    else throw new Error(`Unknown proxy option: ${arg}`);
  }
  if (!["http:", "https:"].includes(options.upstream.protocol)) {
    throw new Error("--upstream must use http: or https:");
  }
  return options;
}

class ProxyHelp extends Error {}

async function prepareBody(
  request: Request,
  reasoningEffortMap?: Record<string, string>,
): Promise<{
  body?: ArrayBuffer;
  originalBody?: ArrayBuffer;
  fixes: number;
  changes: string[];
  adaptReasoning: boolean;
  summary: Record<string, unknown>;
}> {
  if (request.method === "GET" || request.method === "HEAD") {
    return { fixes: 0, adaptReasoning: false, changes: [], summary: {} };
  }
  const original = await request.arrayBuffer();
  if (
    !request.headers.get("content-type")?.toLowerCase().includes("application/json") ||
    original.byteLength === 0
  ) {
    return {
      body: original,
      originalBody: original.byteLength > 0 ? original : undefined,
      fixes: 0,
      adaptReasoning: false,
      changes: [],
      summary: {},
    };
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(original));
    const normalized = normalizeRequestBody(parsed, reasoningEffortMap);
    return {
      body: normalized.fixes === 0
        ? original
        : new TextEncoder().encode(JSON.stringify(normalized.body)).buffer,
      originalBody: original,
      fixes: normalized.fixes,
      changes: normalized.changes,
      adaptReasoning: wantsVscodeReasoningCompatibility(parsed),
      summary: summarizeRequest(parsed),
    };
  } catch {
    return {
      body: original,
      originalBody: original,
      fixes: 0,
      adaptReasoning: false,
      changes: [],
      summary: {},
    };
  }
}

function summarizeRequest(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return {};
  const request = body as JsonObject;
  const clientMetadata = request.client_metadata !== null &&
      typeof request.client_metadata === "object" && !Array.isArray(request.client_metadata)
    ? request.client_metadata as JsonObject
    : {};
  return {
    keys: Object.keys(request).sort(),
    model: typeof request.model === "string" ? request.model : undefined,
    stream: request.stream,
    inputItems: Array.isArray(request.input) ? request.input.length : undefined,
    tools: Array.isArray(request.tools) ? request.tools.length : undefined,
    include: Array.isArray(request.include) ? request.include : undefined,
    previousResponseId: typeof request.previous_response_id === "string"
      ? request.previous_response_id
      : undefined,
    promptCacheKey: typeof request.prompt_cache_key === "string"
      ? request.prompt_cache_key
      : undefined,
    sessionId: typeof clientMetadata.session_id === "string"
      ? clientMetadata.session_id
      : undefined,
    threadId: typeof clientMetadata.thread_id === "string" ? clientMetadata.thread_id : undefined,
    turnId: typeof clientMetadata.turn_id === "string" ? clientMetadata.turn_id : undefined,
  };
}

async function proxy(request: Request, options: ProxyOptions): Promise<Response> {
  const started = performance.now();
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
  const incoming = new URL(request.url);
  const target = new URL(`${incoming.pathname}${incoming.search}`, options.upstream);
  const prepared = await prepareBody(request, options.reasoningEffortMap);
  const requestCapture = prepared.originalBody && options.diagnostics
    ? await options.diagnostics.captureRequest(requestId, prepared.originalBody)
    : undefined;
  options.diagnostics?.log("proxy", "request", {
    requestId,
    method: request.method,
    path: `${incoming.pathname}${incoming.search}`,
    contentType: request.headers.get("content-type"),
    contentLength: request.headers.get("content-length"),
    requestCapture,
    changes: prepared.changes,
    ...prepared.summary,
  });
  if (prepared.adaptReasoning) options.promptProgress?.reset();
  const headers = new Headers(request.headers);
  for (const header of ["host", "content-length", "connection"]) headers.delete(header);
  headers.set("x-forwarded-host", request.headers.get("host") ?? "");
  headers.set("x-forwarded-proto", incoming.protocol.slice(0, -1));
  try {
    const upstream = await fetch(target, {
      method: request.method,
      headers,
      body: prepared.body,
      redirect: "manual",
    });
    const responseHeaders = new Headers(upstream.headers);
    for (const header of ["connection", "content-length", "transfer-encoding"]) {
      responseHeaders.delete(header);
    }
    console.log(
      `${request.method} ${target.pathname} -> ${upstream.status} ` +
        `(${Math.round(performance.now() - started)} ms` +
        (prepared.changes.length > 0 ? `, ${prepared.changes.join(", ")})` : ")"),
    );
    options.diagnostics?.log("proxy", "upstream_response", {
      requestId,
      method: request.method,
      path: target.pathname,
      status: upstream.status,
      elapsedMs: Math.round(performance.now() - started),
      contentType: upstream.headers.get("content-type"),
      changes: prepared.changes,
    });
    if (!upstream.ok) {
      const errorBody = (await upstream.clone().text()).slice(0, 16_384);
      options.diagnostics?.log("proxy", "upstream_error", { requestId, body: errorBody });
    }
    const isSse = upstream.headers.get("content-type")?.toLowerCase().includes("text/event-stream");
    const body = prepared.adaptReasoning && isSse && upstream.body
      ? adaptReasoningStream(
        upstream.body,
        options.promptProgress?.read.bind(options.promptProgress),
        (event) => {
          if (event.type !== "response.completed" && event.type !== "response.incomplete") return;
          const response = event.response !== null && typeof event.response === "object" &&
              !Array.isArray(event.response)
            ? event.response as JsonObject
            : {};
          options.diagnostics?.log("proxy", "response_usage", {
            requestId,
            promptCacheKey: prepared.summary.promptCacheKey,
            sessionId: prepared.summary.sessionId,
            threadId: prepared.summary.threadId,
            turnId: prepared.summary.turnId,
            responseId: typeof response.id === "string" ? response.id : undefined,
            usage: response.usage,
          });
        },
      )
      : upstream.body;
    return new Response(body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    console.error(`Could not reach upstream ${options.upstream}:`, error);
    options.diagnostics?.log("proxy", "upstream_unavailable", {
      requestId,
      elapsedMs: Math.round(performance.now() - started),
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      { error: { message: "Model server upstream is unavailable", type: "proxy_error" } },
      { status: 502 },
    );
  }
}

export async function proxyCommand(args: string[]): Promise<void> {
  let options: ProxyOptions;
  try {
    options = parseProxyArgs(args);
  } catch (error) {
    if (error instanceof ProxyHelp) {
      console.log(error.message);
      return;
    }
    throw error;
  }
  console.log(`Compatibility proxy: http://${options.listenHost}:${options.listenPort}`);
  console.log(`Upstream: ${options.upstream}`);
  console.warn("No authentication is enabled; restrict network access as needed.");
  const diagnostics = defaultDiagnosticLog();
  options.diagnostics = diagnostics;
  diagnostics.log("proxy", "started", {
    listen: `http://${options.listenHost}:${options.listenPort}`,
    upstream: options.upstream.toString(),
  });
  try {
    const server = serveProxy(options);
    await server.finished;
  } finally {
    diagnostics.log("proxy", "stopped");
    await diagnostics.flush();
  }
}

export function serveProxy(options: ProxyOptions, signal?: AbortSignal): Deno.HttpServer {
  return Deno.serve(
    { hostname: options.listenHost, port: options.listenPort, signal },
    (request) => proxy(request, options),
  );
}
