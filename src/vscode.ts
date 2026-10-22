import {
  buildLlamaArgs,
  parseLlamaArgs,
  shellQuote,
  spawnLlama,
  validateLlamaOptions,
} from "./llama.ts";
import { InferenceTracker, serveProxy } from "./proxy.ts";
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

async function waitUntilReady(
  name: string,
  url: string,
  child: Deno.ChildProcess,
  timeoutMs: number,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const exited = await Promise.race([
      child.status.then((status) => ({ status })),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 100)),
    ]);
    if (exited) throw new Error(`${name} exited during startup (${exited.status.code})`);
    try {
      const response = await fetch(url);
      await response.body?.cancel();
      if (response.ok) return;
    } catch {
      // Startup commonly takes tens of seconds for a large model.
    }
  }
  throw new Error(`Timed out waiting for ${name} health check`);
}

/** A model server process that the Responses proxy fronts. */
export interface ProxiedServer {
  name: string;
  spawn(): Deno.ChildProcess;
  /** The child leads its own process group (spawned through setsid); stop the whole group. */
  processGroup: boolean;
  healthUrl: string;
  readyTimeoutMs: number;
  upstream: URL;
  contextLimit: number;
  /** Out-of-band prompt progress read from the server's log lines (llama.cpp). */
  promptProgress?: PromptProgressSource & { inspect(line: string): void };
  diagnostics: Record<string, unknown>;
}

/** Runs `server`, waits for its health check, and serves the Responses proxy in front of it. */
export async function runProxiedServer(
  server: ProxiedServer,
  stack: VscodeStackConfig,
): Promise<void> {
  const diagnostics = defaultDiagnosticLog();
  diagnostics.log("vscode", "started", { server: server.name, ...server.diagnostics });
  const inference = new InferenceTracker(server.contextLimit);
  const child = server.spawn();
  const inspect = (channel: "stdout" | "stderr") => (line: string) => {
    server.promptProgress?.inspect(line);
    diagnostics.log(server.name, channel, { line });
  };
  const outputTasks = [
    mirrorAndInspect(child.stdout, Deno.stdout, inspect("stdout")),
    mirrorAndInspect(child.stderr, Deno.stderr, inspect("stderr")),
  ];
  const abort = new AbortController();
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    abort.abort();
    try {
      if (server.processGroup) Deno.kill(-child.pid, "SIGTERM");
      else child.kill("SIGTERM");
    } catch {
      // It may already have exited.
    }
  };
  Deno.addSignalListener("SIGINT", shutdown);
  Deno.addSignalListener("SIGTERM", shutdown);
  try {
    await waitUntilReady(server.name, server.healthUrl, child, server.readyTimeoutMs);
    console.log(`${server.name} is ready`);
    const proxy = serveProxy({
      listenHost: stack.proxyHost,
      listenPort: stack.proxyPort,
      upstream: server.upstream,
      promptProgress: server.promptProgress,
      inference,
      reasoningEffortMap: stack.reasoningEffortMap,
      diagnostics,
    }, abort.signal);
    console.log(`Responses endpoint: http://${stack.proxyHost}:${stack.proxyPort}/v1/responses`);
    const outcome = await Promise.race([
      child.status.then((status) => ({ kind: "child" as const, status })),
      proxy.finished.then(() => ({ kind: "proxy" as const })),
    ]);
    if (outcome.kind === "child" && !shuttingDown && !outcome.status.success) {
      throw new Error(`${server.name} exited (${outcome.status.code})`);
    }
  } finally {
    shutdown();
    Deno.removeSignalListener("SIGINT", shutdown);
    Deno.removeSignalListener("SIGTERM", shutdown);
    const termination = await terminateChild(
      child,
      stack.shutdownGraceMs ?? 5000,
      server.processGroup,
    );
    if (termination === "killed") console.error(`${server.name} ignored SIGTERM and was killed`);
    await Promise.allSettled(outputTasks);
    diagnostics.log("vscode", "stopped");
    await diagnostics.flush();
  }
}

export async function runVscodeStack(
  options: ReturnType<typeof parseLlamaArgs>,
  stack: VscodeStackConfig,
): Promise<void> {
  options = { ...options, serverArgs: ["--alias", stack.modelAlias, ...options.serverArgs] };

  console.log(
    `VS Code stack: context=${options.context}, KV=${options.cacheTypeK}/${options.cacheTypeV}, ` +
      `speculative=${
        options.dflashDraftTokens > 0
          ? `DFlash/${options.dflashDraftTokens}`
          : options.mtpDraftTokens > 0
          ? `MTP/${options.mtpDraftTokens}`
          : "off"
      }`,
  );
  if (options.dryRun) {
    console.log([options.server, ...buildLlamaArgs(options)].map(shellQuote).join(" "));
    console.log(
      `proxy ${stack.proxyHost}:${stack.proxyPort} -> http://${options.host}:${options.port}`,
    );
    return;
  }

  await validateLlamaOptions(options);
  await runProxiedServer({
    name: "llama-server",
    spawn: () => spawnLlama(options, "piped"),
    processGroup: false,
    healthUrl: `http://${options.host}:${options.port}/health`,
    readyTimeoutMs: 120_000,
    upstream: new URL(`http://${options.host}:${options.port}`),
    contextLimit: options.context,
    promptProgress: new LlamaPromptProgress(),
    diagnostics: {
      model: options.model,
      context: options.context,
      cacheTypeK: options.cacheTypeK,
      cacheTypeV: options.cacheTypeV,
      mtpDraftTokens: options.mtpDraftTokens,
      dflashDraftTokens: options.dflashDraftTokens,
      draftModel: options.draftModel,
    },
  }, stack);
}
