import { parsePort, takeValue } from "./args.ts";

const DEFAULT_LISTEN_HOST = "0.0.0.0";
const DEFAULT_LISTEN_PORT = 1235;
const DEFAULT_UPSTREAM = "http://127.0.0.1:8080";

export interface NormalizationResult {
  body: unknown;
  fixes: number;
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
  };
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
  return syntheticSseBlock({
    type: "response.reasoning_summary_part.done",
    item_id: trace.itemId,
    output_index: -1,
    summary_index: 0,
    part: reasoningSummary(""),
  });
}

function adaptSseBlock(block: string, state: ReasoningStreamState): string {
  const lines = block.split(/\r?\n/);
  const dataIndex = lines.findIndex((line) => line.startsWith("data: "));
  if (dataIndex === -1) return `${block}\n\n`;
  try {
    const event = JSON.parse(lines[dataIndex].slice(6)) as JsonObject;
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
): ReadableStream<Uint8Array> {
  let buffered = "";
  const state: ReasoningStreamState = {
    items: new Map(),
    promptTrace: promptProgress
      ? {
        itemId: `lm-tools-prompt-${crypto.randomUUID()}`,
        active: true,
        lastProgress: -1,
      }
      : undefined,
  };
  let timer: ReturnType<typeof setInterval> | undefined;
  return body.pipeThrough(new TextDecoderStream()).pipeThrough(
    new TransformStream<string, string>({
      start(controller) {
        const trace = state.promptTrace;
        if (!trace || !promptProgress) return;
        controller.enqueue(syntheticSseBlock({
          type: "response.reasoning_summary_text.delta",
          item_id: trace.itemId,
          output_index: -1,
          summary_index: 0,
          delta: "Evaluating prompt…\n",
        }));
        timer = setInterval(() => {
          try {
            const current = promptProgress();
            if (!trace.active || !current || current.progress <= trace.lastProgress) return;
            trace.lastProgress = current.progress;
            const percent = Math.min(100, Math.max(0, Math.round(current.progress * 100)));
            controller.enqueue(syntheticSseBlock({
              type: "response.reasoning_summary_text.delta",
              item_id: trace.itemId,
              output_index: -1,
              summary_index: 0,
              delta: `Prompt evaluation: ${percent}% (${
                current.tokens.toLocaleString("en-US")
              } tokens)\n`,
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
          controller.enqueue(adaptSseBlock(buffered.slice(0, boundary), state));
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

export function normalizeRequestBody(body: unknown): NormalizationResult {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return { body, fixes: 0 };
  const request = body as JsonObject;
  if (!Array.isArray(request.tools)) return { body, fixes: 0 };
  let fixes = 0;
  const tools = request.tools.map((tool) => {
    if (tool === null || typeof tool !== "object" || Array.isArray(tool)) return tool;
    const functionTool = tool as JsonObject;
    if (functionTool.type !== "function" || !isEmptyObject(functionTool.parameters)) return tool;
    fixes++;
    return {
      ...functionTool,
      parameters: { type: "object", properties: {}, additionalProperties: false },
    };
  });
  return fixes === 0 ? { body, fixes: 0 } : { body: { ...request, tools }, fixes };
}

export interface ProxyOptions {
  listenHost: string;
  listenPort: number;
  upstream: URL;
  promptProgress?: PromptProgressSource;
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
): Promise<{ body?: ArrayBuffer; fixes: number; adaptReasoning: boolean }> {
  if (request.method === "GET" || request.method === "HEAD") {
    return { fixes: 0, adaptReasoning: false };
  }
  const original = await request.arrayBuffer();
  if (
    !request.headers.get("content-type")?.toLowerCase().includes("application/json") ||
    original.byteLength === 0
  ) return { body: original, fixes: 0, adaptReasoning: false };
  try {
    const parsed = JSON.parse(new TextDecoder().decode(original));
    const normalized = normalizeRequestBody(parsed);
    return {
      body: normalized.fixes === 0
        ? original
        : new TextEncoder().encode(JSON.stringify(normalized.body)).buffer,
      fixes: normalized.fixes,
      adaptReasoning: wantsVscodeReasoningCompatibility(parsed),
    };
  } catch {
    return { body: original, fixes: 0, adaptReasoning: false };
  }
}

async function proxy(request: Request, options: ProxyOptions): Promise<Response> {
  const started = performance.now();
  const incoming = new URL(request.url);
  const target = new URL(`${incoming.pathname}${incoming.search}`, options.upstream);
  const prepared = await prepareBody(request);
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
        (prepared.fixes ? `, normalized ${prepared.fixes} tool schema(s))` : ")"),
    );
    const isSse = upstream.headers.get("content-type")?.toLowerCase().includes("text/event-stream");
    const body = prepared.adaptReasoning && isSse && upstream.body
      ? adaptReasoningStream(
        upstream.body,
        options.promptProgress?.read.bind(options.promptProgress),
      )
      : upstream.body;
    return new Response(body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    console.error(`Could not reach upstream ${options.upstream}:`, error);
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
  const server = serveProxy(options);
  await server.finished;
}

export function serveProxy(options: ProxyOptions, signal?: AbortSignal): Deno.HttpServer {
  return Deno.serve(
    { hostname: options.listenHost, port: options.listenPort, signal },
    (request) => proxy(request, options),
  );
}
