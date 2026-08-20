import {
  buildLlamaArgs,
  parseLlamaArgs,
  shellQuote,
  spawnLlama,
  validateLlamaOptions,
} from "./llama.ts";
import { serveProxy } from "./proxy.ts";
import type { PromptEvaluationProgress, PromptProgressSource } from "./proxy.ts";
import { defaultDiagnosticLog } from "./log.ts";
import { terminateChild } from "./process_manager.ts";

export const DEFAULT_PROXY_HOST = "127.0.0.1";
export const DEFAULT_PROXY_PORT = 1235;

export interface VscodeStackConfig {
  proxyHost: string;
  proxyPort: number;
  modelAlias: string;
  reasoningEffortMap?: Record<string, string>;
  shutdownGraceMs?: number;
}

export function parsePromptProgressLine(line: string): PromptEvaluationProgress | undefined {
  const match =
    /task\s+(\d+)\s+\|\s+prompt processing,\s+n_tokens\s*=\s*(\d+),\s+progress\s*=\s*([\d.]+)/
      .exec(
        line,
      );
  if (!match) return undefined;
  return {
    taskId: Number(match[1]),
    tokens: Number(match[2]),
    progress: Number(match[3]),
  };
}

class LlamaPromptProgress implements PromptProgressSource {
  #current?: PromptEvaluationProgress;

  reset(): void {
    this.#current = undefined;
  }

  read(): PromptEvaluationProgress | undefined {
    return this.#current;
  }

  inspect(line: string): void {
    const parsed = parsePromptProgressLine(line);
    if (parsed) this.#current = parsed;
  }
}

async function mirrorAndInspect(
  stream: ReadableStream<Uint8Array>,
  destination: { write(data: Uint8Array): Promise<number> },
  inspect: (line: string) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      await destination.write(value);
      buffered += decoder.decode(value, { stream: true }).replaceAll("\r", "");
      let newline: number;
      while ((newline = buffered.indexOf("\n")) !== -1) {
        inspect(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
      }
    }
    buffered += decoder.decode();
    if (buffered) inspect(buffered);
  } finally {
    reader.releaseLock();
  }
}

export function vscodeUsage(): string {
  return `Usage: lm vscode [MODEL] [llama options] [-- llama-server args]

Starts llama-server and the VS Code compatibility proxy together.

Defaults specific to this command:
  context       128k
  KV cache      q8_0 keys / q4_0 values
  MTP drafting  2 tokens
  llama-server  http://127.0.0.1:8080
  VS Code URL   http://${DEFAULT_PROXY_HOST}:${DEFAULT_PROXY_PORT}/v1/responses

All \"lm llama\" options are accepted. The compatibility proxy intentionally
listens only on localhost in this combined mode.`;
}

async function waitUntilReady(url: string, child: Deno.ChildProcess): Promise<void> {
  const deadline = performance.now() + 120_000;
  while (performance.now() < deadline) {
    const exited = await Promise.race([
      child.status.then((status) => ({ status })),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 100)),
    ]);
    if (exited) throw new Error(`llama-server exited during startup (${exited.status.code})`);
    try {
      const response = await fetch(url);
      await response.body?.cancel();
      if (response.ok) return;
    } catch {
      // Startup commonly takes tens of seconds for a large model.
    }
  }
  throw new Error("Timed out waiting for llama-server health check");
}

export async function vscodeCommand(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(vscodeUsage());
    return;
  }
  const inherited = Deno.env.toObject();
  const options = parseLlamaArgs(args, {
    ...inherited,
    CONTEXT_SIZE: inherited.CONTEXT_SIZE ?? "128k",
    KV_CACHE_TYPE_K: inherited.KV_CACHE_TYPE_K ?? inherited.KV_CACHE_TYPE ?? "q8_0",
    KV_CACHE_TYPE_V: inherited.KV_CACHE_TYPE_V ?? inherited.KV_CACHE_TYPE ?? "q4_0",
    MTP_DRAFT_TOKENS: inherited.MTP_DRAFT_TOKENS ?? "2",
  });
  await runVscodeStack(options, {
    proxyHost: DEFAULT_PROXY_HOST,
    proxyPort: DEFAULT_PROXY_PORT,
    modelAlias: "qwen3.8-27b",
  });
}

export async function runVscodeStack(
  options: ReturnType<typeof parseLlamaArgs>,
  stack: VscodeStackConfig,
): Promise<void> {
  options = { ...options, serverArgs: ["--alias", stack.modelAlias, ...options.serverArgs] };

  console.log(
    `VS Code stack: context=${options.context}, KV=${options.cacheTypeK}/${options.cacheTypeV}, ` +
      `MTP=${options.mtpDraftTokens || "off"}`,
  );
  if (options.dryRun) {
    console.log([options.server, ...buildLlamaArgs(options)].map(shellQuote).join(" "));
    console.log(
      `proxy ${stack.proxyHost}:${stack.proxyPort} -> http://${options.host}:${options.port}`,
    );
    return;
  }

  await validateLlamaOptions(options);
  const diagnostics = defaultDiagnosticLog();
  diagnostics.log("vscode", "started", {
    model: options.model,
    context: options.context,
    cacheTypeK: options.cacheTypeK,
    cacheTypeV: options.cacheTypeV,
    mtpDraftTokens: options.mtpDraftTokens,
  });
  const progress = new LlamaPromptProgress();
  const child = spawnLlama(options, "piped");
  const outputTasks = [
    mirrorAndInspect(child.stdout, Deno.stdout, (line) => {
      progress.inspect(line);
      diagnostics.log("llama-server", "stdout", { line });
    }),
    mirrorAndInspect(child.stderr, Deno.stderr, (line) => {
      progress.inspect(line);
      diagnostics.log("llama-server", "stderr", { line });
    }),
  ];
  const abort = new AbortController();
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    abort.abort();
    try {
      child.kill("SIGTERM");
    } catch {
      // It may already have exited.
    }
  };
  Deno.addSignalListener("SIGINT", shutdown);
  Deno.addSignalListener("SIGTERM", shutdown);
  try {
    await waitUntilReady(`http://${options.host}:${options.port}/health`, child);
    console.log("llama-server is ready");
    const proxy = serveProxy({
      listenHost: stack.proxyHost,
      listenPort: stack.proxyPort,
      upstream: new URL(`http://${options.host}:${options.port}`),
      promptProgress: progress,
      reasoningEffortMap: stack.reasoningEffortMap,
      diagnostics,
    }, abort.signal);
    console.log(`VS Code endpoint: http://${stack.proxyHost}:${stack.proxyPort}/v1/responses`);
    const outcome = await Promise.race([
      child.status.then((status) => ({ kind: "child" as const, status })),
      proxy.finished.then(() => ({ kind: "proxy" as const })),
    ]);
    if (outcome.kind === "child" && !shuttingDown && !outcome.status.success) {
      throw new Error(`llama-server exited (${outcome.status.code})`);
    }
  } finally {
    shutdown();
    Deno.removeSignalListener("SIGINT", shutdown);
    Deno.removeSignalListener("SIGTERM", shutdown);
    const termination = await terminateChild(child, stack.shutdownGraceMs ?? 5000);
    if (termination === "killed") console.error("llama-server ignored SIGTERM and was killed");
    await Promise.allSettled(outputTasks);
    diagnostics.log("vscode", "stopped");
    await diagnostics.flush();
  }
}
