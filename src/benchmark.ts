import { parsePositiveInteger, takeValue } from "./args.ts";
import { dirname } from "jsr:@std/path@1";

type JsonObject = Record<string, unknown>;

export interface BenchmarkOptions {
  requestPath: string;
  url: string;
  api: "responses" | "chat-completions";
  maxOutputTokens?: number;
  maxInputChars?: number;
  expectedPromptTokens?: number;
  outputPath?: string;
  vramDevice?: string;
}

export function benchmarkUsage(): string {
  return `Usage: lm benchmark REQUEST [options]

Replay a captured request with wall-time and optional VRAM measurement.

Options:
  --api responses|chat-completions  Request wire format (default: responses)
  --url URL                         Endpoint; defaults from --api
  --max-output-tokens N             Override the captured generation limit
  --max-input-chars N               Truncate role-message text to the first N characters
  --expect-prompt-tokens N          Fail if response usage reports a different prompt size
  --output PATH                     Write the complete JSON result to PATH
  --vram-device PATH                DRM device directory containing mem_info_vram_used
  --help                            Show this help

The chat-completions mode converts role-based OpenAI Responses input and function tools. It rejects
unsupported input item types instead of silently changing a benchmark prompt.`;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) throw new Error("Message content must be a string or content array");
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (!part || typeof part !== "object") throw new Error("Unsupported message content part");
    const item = part as JsonObject;
    if (
      ["input_text", "output_text", "text"].includes(String(item.type)) &&
      typeof item.text === "string"
    ) return item.text;
    throw new Error(`Unsupported message content type: ${String(item.type)}`);
  }).join("");
}

export function responsesToChatCompletions(request: JsonObject): JsonObject {
  if (!Array.isArray(request.input)) {
    throw new Error("Chat conversion requires role-based Responses input");
  }
  const messages = request.input.map((item) => {
    if (!item || typeof item !== "object" || !("role" in item)) {
      throw new Error(`Unsupported Responses input item: ${JSON.stringify(item).slice(0, 120)}`);
    }
    const message = item as JsonObject;
    return { ...message, content: contentText(message.content) };
  });
  const tools = Array.isArray(request.tools)
    ? request.tools.map((tool) => {
      if (!tool || typeof tool !== "object") throw new Error("Unsupported Responses tool");
      const value = tool as JsonObject;
      if (value.type !== "function" || typeof value.name !== "string") {
        throw new Error(`Unsupported Responses tool type: ${String(value.type)}`);
      }
      return {
        type: "function",
        function: {
          name: value.name,
          description: value.description,
          parameters: value.parameters,
        },
      };
    })
    : undefined;
  return {
    model: request.model,
    messages,
    ...(tools?.length ? { tools } : {}),
    stream: false,
    max_completion_tokens: request.max_output_tokens,
  };
}

export function parseBenchmarkArgs(args: string[]): BenchmarkOptions {
  let requestPath: string | undefined;
  let api: BenchmarkOptions["api"] = "responses";
  let url: string | undefined;
  let maxOutputTokens: number | undefined;
  let maxInputChars: number | undefined;
  let expectedPromptTokens: number | undefined;
  let outputPath: string | undefined;
  let vramDevice: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--api") {
      const value = takeValue(args, i++, arg);
      if (value !== "responses" && value !== "chat-completions") {
        throw new Error(`Unsupported benchmark API: ${value}`);
      }
      api = value;
    } else if (arg === "--url") url = takeValue(args, i++, arg);
    else if (arg === "--max-output-tokens") {
      maxOutputTokens = parsePositiveInteger(takeValue(args, i++, arg), arg);
    } else if (arg === "--max-input-chars") {
      maxInputChars = parsePositiveInteger(takeValue(args, i++, arg), arg);
    } else if (arg === "--expect-prompt-tokens") {
      expectedPromptTokens = parsePositiveInteger(takeValue(args, i++, arg), arg);
    } else if (arg === "--output") outputPath = takeValue(args, i++, arg);
    else if (arg === "--vram-device") vramDevice = takeValue(args, i++, arg);
    else if (arg.startsWith("-")) throw new Error(`Unknown benchmark option: ${arg}`);
    else if (requestPath) throw new Error("Only one benchmark request may be supplied");
    else requestPath = arg;
  }
  if (!requestPath) throw new Error(`A captured request is required\n\n${benchmarkUsage()}`);
  return {
    requestPath,
    api,
    url: url ??
      (api === "responses"
        ? "http://127.0.0.1:1235/v1/responses"
        : "http://127.0.0.1:8000/v1/chat/completions"),
    maxOutputTokens,
    maxInputChars,
    expectedPromptTokens,
    outputPath,
    vramDevice,
  };
}

export function truncateRoleInput(request: JsonObject, maxChars: number): void {
  if (!Array.isArray(request.input)) {
    throw new Error("Input truncation requires role-based Responses input");
  }
  let remaining = maxChars;
  for (const rawMessage of request.input) {
    if (!rawMessage || typeof rawMessage !== "object" || !("role" in rawMessage)) {
      throw new Error("Input truncation requires role-based Responses messages");
    }
    const message = rawMessage as JsonObject;
    if (typeof message.content === "string") {
      const text = message.content.slice(0, remaining);
      message.content = text;
      remaining = Math.max(0, remaining - text.length);
      continue;
    }
    if (!Array.isArray(message.content)) throw new Error("Unsupported message content");
    for (const rawPart of message.content) {
      if (!rawPart || typeof rawPart !== "object") {
        throw new Error("Unsupported message content part");
      }
      const part = rawPart as JsonObject;
      if (typeof part.text !== "string") {
        throw new Error(`Unsupported message content type: ${String(part.type)}`);
      }
      const text = part.text.slice(0, remaining);
      part.text = text;
      remaining = Math.max(0, remaining - text.length);
    }
  }
}

async function readVram(path: string | undefined): Promise<number | undefined> {
  if (!path) return undefined;
  return Number(await Deno.readTextFile(`${path.replace(/\/$/, "")}/mem_info_vram_used`));
}

async function sampleVram(
  path: string | undefined,
  done: () => boolean,
): Promise<number | undefined> {
  if (!path) return undefined;
  let peak = 0;
  while (!done()) {
    peak = Math.max(peak, await readVram(path) ?? 0);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return Math.max(peak, await readVram(path) ?? 0);
}

export async function benchmarkCommand(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(benchmarkUsage());
    return;
  }
  const options = parseBenchmarkArgs(args);
  const captured = JSON.parse(await Deno.readTextFile(options.requestPath)) as JsonObject;
  if (options.maxInputChars !== undefined) truncateRoleInput(captured, options.maxInputChars);
  if (options.maxOutputTokens !== undefined) captured.max_output_tokens = options.maxOutputTokens;
  const request = options.api === "responses" ? captured : responsesToChatCompletions(captured);
  if (options.api === "chat-completions" && options.maxOutputTokens !== undefined) {
    request.max_completion_tokens = options.maxOutputTokens;
  }

  const vramBefore = await readVram(options.vramDevice);
  let done = false;
  const sampler = sampleVram(options.vramDevice, () => done);
  const startedAt = new Date().toISOString();
  const start = performance.now();
  let response: Response;
  let responseText: string;
  try {
    response = await fetch(options.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    responseText = await response.text();
  } finally {
    done = true;
  }
  const wallMs = performance.now() - start;
  const peakVram = await sampler;
  const vramAfter = await readVram(options.vramDevice);
  let responseBody: unknown = responseText;
  try {
    responseBody = JSON.parse(responseText);
  } catch {
    // Streaming Responses output remains text so event framing is preserved.
  }
  const reportedPromptTokens = responseBody && typeof responseBody === "object" &&
      "usage" in responseBody && responseBody.usage && typeof responseBody.usage === "object" &&
      "prompt_tokens" in responseBody.usage && typeof responseBody.usage.prompt_tokens === "number"
    ? responseBody.usage.prompt_tokens
    : undefined;
  const promptTokenGate = options.expectedPromptTokens === undefined ? undefined : {
    expected: options.expectedPromptTokens,
    actual: reportedPromptTokens,
    passed: reportedPromptTokens === options.expectedPromptTokens,
  };
  const result = {
    version: 1,
    startedAt,
    requestPath: options.requestPath,
    url: options.url,
    api: options.api,
    requestShape: {
      maxInputChars: options.maxInputChars,
      maxOutputTokens: options.maxOutputTokens,
    },
    status: response.status,
    ok: response.ok,
    wallMs,
    vram: options.vramDevice
      ? {
        device: options.vramDevice,
        beforeMiB: Math.round((vramBefore ?? 0) / 1048576),
        peakMiB: Math.round((peakVram ?? 0) / 1048576),
        afterMiB: Math.round((vramAfter ?? 0) / 1048576),
      }
      : undefined,
    gates: promptTokenGate ? { promptTokens: promptTokenGate } : undefined,
    response: responseBody,
  };
  const output = `${JSON.stringify(result, null, 2)}\n`;
  if (options.outputPath) {
    await Deno.mkdir(dirname(options.outputPath), { recursive: true });
    await Deno.writeTextFile(options.outputPath, output);
    console.log(
      `Benchmark HTTP ${response.status}: ${(wallMs / 1000).toFixed(2)} s` +
        (peakVram === undefined ? "" : `, peak VRAM ${Math.round(peakVram / 1048576)} MiB`) +
        `; result ${options.outputPath}`,
    );
  } else {
    console.log(output.trimEnd());
  }
  if (!response.ok) throw new Error(`Benchmark endpoint returned HTTP ${response.status}`);
  if (promptTokenGate && !promptTokenGate.passed) {
    throw new Error(
      `Expected ${promptTokenGate.expected} prompt tokens, got ${String(promptTokenGate.actual)}`,
    );
  }
}
