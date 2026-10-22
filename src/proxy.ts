import { parsePort, takeValue } from "./args.ts";
import { defaultDiagnosticLog, DiagnosticLog } from "./log.ts";

const DEFAULT_LISTEN_HOST = "0.0.0.0";
const DEFAULT_LISTEN_PORT = 1235;
const DEFAULT_UPSTREAM = "http://127.0.0.1:8080";

export interface NormalizationResult {
  body: unknown;
  fixes: number;
  changes: string[];
}

type JsonObject = Record<string, unknown>;

export type ProxyTraceEvent = {
  method: string;
  item?: JsonObject;
  params?: JsonObject;
};

function traceItemId(value: JsonObject, fallback: string): string {
  for (const key of ["call_id", "id", "item_id"]) {
    if (typeof value[key] === "string" && value[key]) return value[key] as string;
  }
  return fallback;
}

function traceText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function traceToolExitCode(output: unknown): number {
  let value = output;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return 0;
    }
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return 0;
  const record = value as JsonObject;
  const details = record.details !== null && typeof record.details === "object" &&
      !Array.isArray(record.details)
    ? record.details as JsonObject
    : record;
  const exitCode = details.exitCode ?? details.exit_code;
  if (typeof exitCode === "number") return exitCode;
  return record.isError === true || record.status === "error" ? 1 : 0;
}

function traceToolCommand(name: string, argumentsValue: unknown): string {
  let parsed = argumentsValue;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return parsed ? `${name}\n${parsed}` : name;
    }
  }
  if (
    name === "exec" && parsed !== null && typeof parsed === "object" &&
    !Array.isArray(parsed) && typeof (parsed as JsonObject).command === "string"
  ) {
    return (parsed as JsonObject).command as string;
  }
  const argumentsText = traceText(parsed);
  return argumentsText ? `${name}\n${argumentsText}` : name;
}

/** Normalize newly supplied tool results into the observer's transport-neutral timeline. */
export function proxyTraceRequestEvents(body: unknown): ProxyTraceEvent[] {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return [];
  const input = (body as JsonObject).input;
  if (!Array.isArray(input)) return [];
  return input.flatMap((candidate, index) => {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const item = candidate as JsonObject;
    if (item.type !== "function_call_output") return [];
    const id = traceItemId(item, `tool-result-${index}`);
    return [{
      method: "item/completed",
      item: {
        id,
        type: "commandExecution",
        aggregatedOutput: traceText(item.output),
        exitCode: traceToolExitCode(item.output),
      },
    }];
  });
}

/** Normalize an OpenAI Responses stream event without depending on the calling agent system. */
export function proxyTraceResponseEvents(event: JsonObject): ProxyTraceEvent[] {
  const type = typeof event.type === "string" ? event.type : "";
  const item = event.item !== null && typeof event.item === "object" && !Array.isArray(event.item)
    ? event.item as JsonObject
    : null;
  const id = traceItemId(
    event,
    item ? traceItemId(item, crypto.randomUUID()) : crypto.randomUUID(),
  );
  if (type === "response.output_text.delta" && typeof event.delta === "string") {
    return [{ method: "item/agentMessage/delta", params: { itemId: id, delta: event.delta } }];
  }
  if (
    (type === "response.reasoning_text.delta" ||
      type === "response.reasoning_summary_text.delta") && typeof event.delta === "string"
  ) {
    return [{ method: "item/reasoning/textDelta", params: { itemId: id, delta: event.delta } }];
  }
  if (type === "response.output_item.added" && item?.type === "function_call") {
    const callId = traceItemId(item, id);
    return [{
      method: "item/started",
      item: {
        id: callId,
        type: "commandExecution",
        command: typeof item.name === "string" ? item.name : "tool",
        aggregatedOutput: "",
      },
    }];
  }
  if (type === "response.output_item.done" && item?.type === "function_call") {
    const callId = traceItemId(item, id);
    const name = typeof item.name === "string" ? item.name : "tool";
    return [{
      method: "item/started",
      item: {
        id: callId,
        type: "commandExecution",
        command: traceToolCommand(name, item.arguments),
        aggregatedOutput: "",
      },
    }];
  }
  if (type === "response.output_item.done" && item?.type === "message") {
    const content = Array.isArray(item.content) ? item.content : [];
    const text = content.flatMap((part) => {
      if (part === null || typeof part !== "object" || Array.isArray(part)) return [];
      const value = part as JsonObject;
      return typeof value.text === "string" ? [value.text] : [];
    }).join("\n");
    return text
      ? [{
        method: "item/completed",
        item: { id: traceItemId(item, id), type: "agentMessage", text },
      }]
      : [];
  }
  if (type === "error") {
    const error = event.error !== null && typeof event.error === "object" &&
        !Array.isArray(event.error)
      ? event.error as JsonObject
      : event;
    return [{
      method: "error",
      params: { error: { message: traceText(error.message ?? error) } },
    }];
  }
  return [];
}

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

/** SSE events that open the synthetic prompt-evaluation reasoning item. */
function openPromptTrace(trace: NonNullable<ReasoningStreamState["promptTrace"]>): string {
  const item = { id: trace.itemId, type: "reasoning", status: "in_progress", summary: [] };
  return [
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
  ].map(syntheticSseBlock).join("");
}

/** One progress line for the prompt-evaluation trace, or "" when it would not advance. */
function promptTraceProgress(
  trace: NonNullable<ReasoningStreamState["promptTrace"]>,
  current: PromptEvaluationProgress,
): string {
  if (!trace.active || current.progress <= trace.lastProgress) return "";
  trace.lastProgress = current.progress;
  const percent = Math.min(100, Math.max(0, Math.round(current.progress * 100)));
  const delta = `Prompt evaluation: ${percent}% (${
    current.tokens.toLocaleString("en-US")
  } tokens)\n`;
  trace.text += delta;
  return syntheticSseBlock({
    type: "response.reasoning_summary_text.delta",
    item_id: trace.itemId,
    output_index: -1,
    summary_index: 0,
    delta,
  });
}

/** Upstream-native prompt progress: hipfire's `hipfire.prefill_progress` (`done` / `total`). */
const PREFILL_PROGRESS_EVENT = "hipfire.prefill_progress";

function prefillProgress(event: JsonObject): PromptEvaluationProgress | undefined {
  const { done, total } = event;
  if (typeof done !== "number" || typeof total !== "number" || total <= 0) return undefined;
  return { taskId: 0, tokens: done, progress: done / total };
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
    if (type === PREFILL_PROGRESS_EVENT) {
      // Rendered as the prompt-evaluation trace (opened on the first event
      // when no out-of-band progress source started one); never forwarded.
      const current = prefillProgress(event);
      let rendered = "";
      if (!state.promptTrace) {
        state.promptTrace = {
          itemId: systemReasoningItemId("prompt-evaluation"),
          active: true,
          lastProgress: -1,
          text: "Evaluating prompt…\n",
        };
        rendered += openPromptTrace(state.promptTrace);
      }
      if (current) rendered += promptTraceProgress(state.promptTrace, current);
      return rendered;
    }
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

/** Whether an SSE block is upstream prompt progress, which only the trace renders. */
function isPrefillProgressBlock(block: string): boolean {
  return block.split("\n").some((line) =>
    line === `event: ${PREFILL_PROGRESS_EVENT}` ||
    line.startsWith("data: ") && line.includes(`"type":"${PREFILL_PROGRESS_EVENT}"`)
  );
}

/**
 * Passes an SSE body through while emitting proxy-trace events. Upstream
 * prompt-progress events are dropped: they are not part of the Responses API.
 *
 * Stream *adaptation* is gated on `include: reasoning.encrypted_content`,
 * because only clients asking for that need the VS Code reasoning shape.
 * Observation must not be: auxiliary calls (compression summaries, titles)
 * send no tools, no reasoning and no include, and would otherwise render in
 * the observer as an opaque, growing token count with no explanation.
 */
export function observeStream(
  body: ReadableStream<Uint8Array>,
  observe: (event: JsonObject) => void,
): ReadableStream<Uint8Array> {
  let buffered = "";
  const consume = (block: string) => {
    for (const line of block.split("\n")) {
      const trimmed = line.trimStart();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const parsed = JSON.parse(payload);
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          observe(parsed as JsonObject);
        }
      } catch {
        // A partial or non-JSON frame is not worth failing the stream over.
      }
    }
  };
  return body.pipeThrough(new TextDecoderStream()).pipeThrough(
    new TransformStream<string, string>({
      transform(chunk, controller) {
        buffered += chunk.replaceAll("\r\n", "\n");
        let boundary: number;
        while ((boundary = buffered.indexOf("\n\n")) !== -1) {
          const block = buffered.slice(0, boundary);
          consume(block);
          if (!isPrefillProgressBlock(block)) controller.enqueue(`${block}\n\n`);
          buffered = buffered.slice(boundary + 2);
        }
      },
      flush(controller) {
        if (buffered.length > 0) {
          consume(buffered);
          controller.enqueue(buffered);
        }
      },
    }),
  ).pipeThrough(new TextEncoderStream());
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
        controller.enqueue(openPromptTrace(trace));
        timer = setInterval(() => {
          try {
            const current = promptProgress();
            if (!current) return;
            const delta = promptTraceProgress(trace, current);
            if (delta) controller.enqueue(delta);
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

function anchorSchemaPatterns(value: unknown): { value: unknown; fixes: number } {
  if (Array.isArray(value)) {
    let fixes = 0;
    const output = value.map((item) => {
      const normalized = anchorSchemaPatterns(item);
      fixes += normalized.fixes;
      return normalized.value;
    });
    return { value: fixes === 0 ? value : output, fixes };
  }
  if (value === null || typeof value !== "object") return { value, fixes: 0 };
  let fixes = 0;
  const output: JsonObject = {};
  for (const [key, item] of Object.entries(value as JsonObject)) {
    if (
      key === "pattern" && typeof item === "string" &&
      !(item.startsWith("^") && item.endsWith("$"))
    ) {
      // llama.cpp requires full anchors and its grammar converter does not accept
      // JavaScript's \S shorthand. Preserve that "contains non-whitespace"
      // constraint with the small character class understood by llama.cpp.
      const compatible = item === "\\S" ? "[^ \\t\\r\\n]" : item;
      const prefix = compatible.startsWith("^") ? "" : ".*";
      const suffix = compatible.endsWith("$") ? "" : ".*";
      output[key] = `^${prefix}(?:${compatible})${suffix}$`;
      fixes++;
      continue;
    }
    const normalized = anchorSchemaPatterns(item);
    output[key] = normalized.value;
    fixes += normalized.fixes;
  }
  return { value: fixes === 0 ? value : output, fixes };
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

function normalizeMultimodalToolOutputs(input: unknown): {
  value: unknown;
  fixes: number;
  images: number;
} {
  if (!Array.isArray(input)) return { value: input, fixes: 0, images: 0 };
  const normalized: unknown[] = [];
  let fixes = 0;
  let images = 0;
  for (const value of input) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      normalized.push(value);
      continue;
    }
    const item = value as JsonObject;
    if (item.type !== "function_call_output" || !Array.isArray(item.output)) {
      normalized.push(value);
      continue;
    }

    const text: string[] = [];
    const imageParts: JsonObject[] = [];
    for (const part of item.output) {
      if (part !== null && typeof part === "object" && !Array.isArray(part)) {
        const content = part as JsonObject;
        if (content.type === "input_text" && typeof content.text === "string") {
          text.push(content.text);
          continue;
        }
        if (content.type === "input_image" && typeof content.image_url === "string") {
          imageParts.push(content);
          continue;
        }
      }
      text.push(JSON.stringify(part));
    }
    normalized.push({
      ...item,
      output: text.join("\n\n") || `[Tool returned ${imageParts.length} image(s)]`,
    });
    if (imageParts.length > 0) {
      const callId = typeof item.call_id === "string" ? item.call_id : "unknown";
      normalized.push({
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: `Image output from tool call ${callId}.` },
          ...imageParts,
        ],
      });
    }
    fixes++;
    images += imageParts.length;
  }
  return fixes === 0 ? { value: input, fixes: 0, images: 0 } : { value: normalized, fixes, images };
}

/**
 * Gives every Responses input item an explicit `type`.
 *
 * The OpenAI Responses API infers `type: "message"` for a bare
 * `{role, content}` item; llama.cpp does not, and rejects the whole request
 * with `400 Cannot determine type of 'item'`. Clients that target OpenAI
 * directly (Hermes' codex_responses transport among them) legitimately omit
 * it, so the proxy fills it in rather than each client learning this quirk.
 */
function typeResponsesInputItems(request: JsonObject): { request: JsonObject; fixes: number } {
  const input = request.input;
  if (!Array.isArray(input)) return { request, fixes: 0 };
  let fixes = 0;
  const items = input.map((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return item;
    const record = item as JsonObject;
    if (typeof record.type === "string" || typeof record.role !== "string") return item;
    fixes += 1;
    return { type: "message", ...record };
  });
  return fixes === 0 ? { request, fixes: 0 } : { request: { ...request, input: items }, fixes };
}

export function normalizeRequestBody(
  body: unknown,
  reasoningEffortMap: Record<string, string> = {},
  defaultReasoningEffort?: string,
): NormalizationResult {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { body, fixes: 0, changes: [] };
  }
  const request = body as JsonObject;
  let fixes = 0;
  const changes: string[] = [];
  let normalized = request;

  // Auxiliary calls (compression summaries, titles) omit `reasoning` entirely.
  // With no directive the Qwen chat template falls back to thinking ON, so a
  // client that asked for "no thinking" by sending nothing still gets it.
  // Supplying the default here is the only place that knows the deployment.
  if (
    defaultReasoningEffort && !Object.hasOwn(request, "reasoning") &&
    Array.isArray(request.input)
  ) {
    normalized = { ...normalized, reasoning: { effort: defaultReasoningEffort } };
    fixes++;
    changes.push(`defaulted absent reasoning effort to ${defaultReasoningEffort}`);
  }

  const reasoning = normalized.reasoning;
  if (reasoning !== null && typeof reasoning === "object" && !Array.isArray(reasoning)) {
    const effort = (reasoning as JsonObject).effort;
    if (typeof effort === "string") {
      const wireEffort = reasoningEffortMap[effort] ?? effort;
      if (wireEffort !== "none") {
        // The chat_template_kwargs write below is only load-bearing on llama.cpp builds
        // older than b10434. Those accept reasoning_effort but drop it before the template,
        // so the effort never reaches Qwen. From b10434 (upstream 7e4c0a96) the server
        // merges request kwargs first and then overwrites reasoning_effort itself with an
        // identical dumped value, making this a no-op rather than a conflict. "none" is
        // excluded because every build supporting it maps "none" to enable_thinking=false
        // and erases the kwarg. The wireEffort mapping itself is always required.
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

    const toolOutputs = normalizeMultimodalToolOutputs(normalized.input);
    if (toolOutputs.fixes > 0) {
      normalized = { ...normalized, input: toolOutputs.value };
      fixes += toolOutputs.fixes;
      changes.push(
        `normalized ${toolOutputs.fixes} array tool output(s), lifting ${toolOutputs.images} image(s)`,
      );
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
    let patternFixes = 0;
    const tools = request.tools.map((tool) => {
      if (tool === null || typeof tool !== "object" || Array.isArray(tool)) return tool;
      const functionTool = tool as JsonObject;
      if (functionTool.type !== "function") return tool;
      if (isEmptyObject(functionTool.parameters)) {
        fixes++;
        toolFixes++;
        return {
          ...functionTool,
          parameters: { type: "object", properties: {}, additionalProperties: false },
        };
      }
      const parameters = anchorSchemaPatterns(functionTool.parameters);
      fixes += parameters.fixes;
      patternFixes += parameters.fixes;
      return parameters.fixes === 0 ? tool : { ...functionTool, parameters: parameters.value };
    });
    if (toolFixes > 0 || patternFixes > 0) {
      normalized = { ...normalized, tools };
    }
    if (toolFixes > 0) {
      changes.push(`normalized ${toolFixes} empty tool schema(s)`);
    }
    if (patternFixes > 0) {
      changes.push(`anchored ${patternFixes} tool schema pattern(s)`);
    }
  }

  {
    const typed = typeResponsesInputItems(normalized);
    if (typed.fixes > 0) {
      normalized = typed.request;
      fixes += typed.fixes;
      changes.push(`typed ${typed.fixes} untyped input item(s) as message`);
    }
  }
  return fixes === 0 ? { body, fixes: 0, changes } : { body: normalized, fixes, changes };
}

/**
 * Authoritative inference snapshot for observers.
 *
 * llama.cpp's `/slots` counters are not an atomic snapshot: `n_prompt_tokens`
 * absorbs decoded output while generating, so a consumer that divides
 * processed by total watches both operands move and sees the ratio hover near
 * 100%. The proxy already holds better numbers -- llama's own cumulative
 * `progress` fraction and the billed usage from the last completed response --
 * so it serves them directly instead.
 */
export interface InferenceSnapshot {
  active: boolean;
  phase: "prompt" | "generation" | "idle";
  taskId: number | null;
  prompt: { processed: number; total: number; cached: number; percent: number };
  context: { used: number; limit: number; percent: number } | null;
  updatedAt: string | null;
}

export class InferenceTracker {
  #lastInputTokens = 0;
  #lastCachedTokens = 0;
  #contextLimit = 0;
  #updatedAt: string | null = null;
  #generating = false;
  #streamedProgress?: PromptEvaluationProgress;

  constructor(contextLimit = 0) {
    this.#contextLimit = contextLimit;
  }

  /** Records billed prompt size and cache hits from a completed response. */
  observeUsage(inputTokens: number, cachedTokens = 0): void {
    if (!Number.isFinite(inputTokens) || inputTokens <= 0) return;
    this.#lastInputTokens = Math.floor(inputTokens);
    this.#lastCachedTokens = Number.isFinite(cachedTokens) && cachedTokens > 0
      ? Math.floor(cachedTokens)
      : 0;
    this.#updatedAt = new Date().toISOString();
    this.#generating = false;
    this.#streamedProgress = undefined;
  }

  /** Records prompt progress the upstream streamed in-band (`hipfire.prefill_progress`). */
  observePromptProgress(progress: PromptEvaluationProgress): void {
    this.#streamedProgress = progress;
    this.#generating = false;
    this.#updatedAt = new Date().toISOString();
  }

  /** Marks the transition out of prompt evaluation into token generation. */
  observeGenerating(): void {
    this.#generating = true;
    this.#streamedProgress = undefined;
    this.#updatedAt = new Date().toISOString();
  }

  snapshot(sourceProgress?: PromptEvaluationProgress): InferenceSnapshot {
    const progress = sourceProgress ?? this.#streamedProgress;
    const limit = this.#contextLimit;
    const used = this.#lastInputTokens;
    // llama reports a cumulative fraction per task, so total is recoverable
    // from it without touching the racing slot counters.
    const fraction = progress ? Math.min(1, Math.max(0, progress.progress)) : 0;
    const processed = progress?.tokens ?? 0;
    const total = progress && fraction > 0 ? Math.round(processed / fraction) : processed;
    const active = progress !== undefined || this.#generating;
    return {
      active,
      phase: progress ? "prompt" : this.#generating ? "generation" : "idle",
      taskId: progress?.taskId ?? null,
      prompt: { processed, total, cached: this.#lastCachedTokens, percent: fraction },
      context: limit > 0
        ? { used, limit, percent: Math.min(1, used / limit) }
        : used > 0
        ? { used, limit: 0, percent: 0 }
        : null,
      updatedAt: this.#updatedAt,
    };
  }
}

export interface ProxyOptions {
  listenHost: string;
  listenPort: number;
  upstream: URL;
  promptProgress?: PromptProgressSource;
  inference?: InferenceTracker;
  /** Applied only when a request omits `reasoning` (auxiliary model calls). */
  defaultReasoningEffort?: string;
  reasoningEffortMap?: Record<string, string>;
  diagnostics?: DiagnosticLog;
  trace?: DiagnosticLog;
}

export function proxyUsage(): string {
  return `Usage: lm proxy [options]

Options:
  --listen-host HOST  Address to listen on (default: ${DEFAULT_LISTEN_HOST})
  --listen-port PORT  Port to listen on (default: ${DEFAULT_LISTEN_PORT})
  --upstream URL      OpenAI-compatible server (default: ${DEFAULT_UPSTREAM})
  --context-limit N   Model context size reported on ${INFERENCE_ROUTE}
  --help              Show this help

The proxy has no authentication. Do not expose it to an untrusted network.`;
}

function parseContextLimit(value: string, arg: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${arg} must be a positive integer`);
  }
  return parsed;
}

function parseProxyArgs(args: string[]): ProxyOptions {
  let contextLimit = 0;
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
    else if (arg === "--context-limit") contextLimit = parseContextLimit(value, arg);
    else throw new Error(`Unknown proxy option: ${arg}`);
  }
  if (!["http:", "https:"].includes(options.upstream.protocol)) {
    throw new Error("--upstream must use http: or https:");
  }
  return { ...options, inference: new InferenceTracker(contextLimit) };
}

class ProxyHelp extends Error {}

async function prepareBody(
  request: Request,
  reasoningEffortMap?: Record<string, string>,
  defaultReasoningEffort?: string,
): Promise<{
  body?: ArrayBuffer;
  originalBody?: ArrayBuffer;
  fixes: number;
  changes: string[];
  adaptReasoning: boolean;
  summary: Record<string, unknown>;
  traceEvents: ProxyTraceEvent[];
}> {
  if (request.method === "GET" || request.method === "HEAD") {
    return { fixes: 0, adaptReasoning: false, changes: [], summary: {}, traceEvents: [] };
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
      traceEvents: [],
    };
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(original));
    const normalized = normalizeRequestBody(parsed, reasoningEffortMap, defaultReasoningEffort);
    return {
      body: normalized.fixes === 0
        ? original
        : new TextEncoder().encode(JSON.stringify(normalized.body)).buffer,
      originalBody: original,
      fixes: normalized.fixes,
      changes: normalized.changes,
      adaptReasoning: wantsVscodeReasoningCompatibility(parsed),
      summary: summarizeRequest(parsed),
      traceEvents: proxyTraceRequestEvents(normalized.body),
    };
  } catch {
    return {
      body: original,
      originalBody: original,
      fixes: 0,
      adaptReasoning: false,
      changes: [],
      summary: {},
      traceEvents: [],
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

/** Read-only observability route; never forwarded upstream. */
export const INFERENCE_ROUTE = "/lm-tools/inference";

async function proxy(request: Request, options: ProxyOptions): Promise<Response> {
  const started = performance.now();
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
  const incoming = new URL(request.url);
  if (incoming.pathname === INFERENCE_ROUTE) {
    const snapshot = (options.inference ?? new InferenceTracker()).snapshot(
      options.promptProgress?.read(),
    );
    return new Response(JSON.stringify(snapshot), {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }
  const target = new URL(`${incoming.pathname}${incoming.search}`, options.upstream);
  const prepared = await prepareBody(
    request,
    options.reasoningEffortMap,
    options.defaultReasoningEffort,
  );
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
  for (const event of prepared.traceEvents) {
    options.trace?.log("proxy-trace", "event", { requestId, event });
  }
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
    const observeResponseEvent = (event: JsonObject) => {
      if (event.type === PREFILL_PROGRESS_EVENT) {
        const progress = prefillProgress(event);
        if (progress) options.inference?.observePromptProgress(progress);
        return;
      }
      for (const normalized of proxyTraceResponseEvents(event)) {
        options.trace?.log("proxy-trace", "event", { requestId, event: normalized });
      }
      // The first real output delta is the stable prompt->generation boundary.
      if (
        event.type === "response.output_text.delta" ||
        event.type === "response.reasoning_summary_text.delta" &&
          !isSystemReasoningItem({ id: event.item_id })
      ) {
        options.inference?.observeGenerating();
      }
      if (event.type !== "response.completed" && event.type !== "response.incomplete") return;
      const response = event.response !== null && typeof event.response === "object" &&
          !Array.isArray(event.response)
        ? event.response as JsonObject
        : {};
      const usage = response.usage !== null && typeof response.usage === "object" &&
          !Array.isArray(response.usage)
        ? response.usage as JsonObject
        : undefined;
      if (typeof usage?.input_tokens === "number") {
        const details = usage.input_tokens_details !== null &&
            typeof usage.input_tokens_details === "object" &&
            !Array.isArray(usage.input_tokens_details)
          ? usage.input_tokens_details as JsonObject
          : undefined;
        options.inference?.observeUsage(
          usage.input_tokens,
          typeof details?.cached_tokens === "number" ? details.cached_tokens : 0,
        );
      }
      options.diagnostics?.log("proxy", "response_usage", {
        requestId,
        promptCacheKey: prepared.summary.promptCacheKey,
        sessionId: prepared.summary.sessionId,
        threadId: prepared.summary.threadId,
        turnId: prepared.summary.turnId,
        responseId: typeof response.id === "string" ? response.id : undefined,
        usage: response.usage,
      });
    };
    const body = isSse && upstream.body
      ? prepared.adaptReasoning
        ? adaptReasoningStream(
          upstream.body,
          options.promptProgress?.read.bind(options.promptProgress),
          observeResponseEvent,
        )
        : observeStream(upstream.body, observeResponseEvent)
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
  const defaultEffort = Deno.env.get("LM_TOOLS_DEFAULT_REASONING_EFFORT")?.trim();
  if (defaultEffort) {
    options.defaultReasoningEffort = defaultEffort;
    console.log(`Default reasoning effort for requests without one: ${defaultEffort}`);
  }
  const tracePath = Deno.env.get("LM_TOOLS_PROXY_TRACE");
  const trace = tracePath ? new DiagnosticLog(tracePath) : undefined;
  options.trace = trace;
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
    await trace?.flush();
  }
}

export function serveProxy(options: ProxyOptions, signal?: AbortSignal): Deno.HttpServer {
  return Deno.serve(
    { hostname: options.listenHost, port: options.listenPort, signal },
    (request) => proxy(request, options),
  );
}
