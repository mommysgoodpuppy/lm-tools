import { parseNonNegativeInteger, parsePort, parsePositiveInteger, takeValue } from "./args.ts";
import { terminateChild } from "./process_manager.ts";

const DEFAULT_MODEL =
  "/home/ellie/.lmstudio/models/lmstudio-community/Qwen3.8-27B-GGUF/Qwen3.8-27B-Q4_K_M.gguf";
const DEFAULT_SERVER = "/usr/bin/llama-server";

export interface LlamaOptions {
  model: string;
  server: string;
  host: string;
  port: number;
  context: number;
  cacheTypeK: string;
  cacheTypeV: string;
  gpuLayers: string;
  flashAttention: boolean;
  batchSize: number;
  ubatchSize: number;
  parallel: number;
  mtpDraftTokens: number;
  mmproj?: string;
  webui: boolean;
  dryRun: boolean;
  serverArgs: string[];
}

export function llamaUsage(): string {
  return `Usage: lm llama [MODEL] [options] [-- llama-server args]

Options:
  --model PATH          GGUF model (or MODEL_PATH; defaults to the local Qwen model)
  --server PATH         llama-server executable (or LLAMA_SERVER; default: ${DEFAULT_SERVER})
  --context TOKENS      Context size; accepts 8192, 64k, 1m (default: 64k)
  --host HOST           Listen address (default: 127.0.0.1)
  --port PORT           Listen port (or PORT; default: 8080)
  --kv TYPE             Set both KV cache types (default: q8_0)
  --kv-k TYPE           K cache type
  --kv-v TYPE           V cache type
  --gpu-layers N|all    Layers to offload (default: all)
  --batch-size N        Logical batch size (default: 1024)
  --ubatch-size N       Physical batch size (default: 256)
  --parallel N          Concurrent sequences (default: 1)
  --mtp N               Native MTP draft tokens; 0 disables it (default: 0)
  --mmproj PATH         Enable vision with this projector
  --no-webui            Disable llama.cpp's web UI
  --dry-run             Print the resolved command without starting it
  --help                Show this help

Extra arguments after -- are appended last and can override llama.cpp defaults.`;
}

export function parseContext(value: string): number {
  const match = /^(\d+)([kKmM]?)$/.exec(value);
  if (!match) throw new Error(`Invalid context \"${value}\"; use 8192, 64k, or 1m`);
  const multiplier = match[2].toLowerCase() === "k"
    ? 1024
    : match[2].toLowerCase() === "m"
    ? 1024 * 1024
    : 1;
  return parsePositiveInteger(String(Number(match[1]) * multiplier), "--context");
}

export function parseLlamaArgs(args: string[], env = Deno.env.toObject()): LlamaOptions {
  const separator = args.indexOf("--");
  const ownArgs = separator === -1 ? args : args.slice(0, separator);
  const serverArgs = separator === -1 ? [] : args.slice(separator + 1);
  const commonKv = env.KV_CACHE_TYPE ?? "q8_0";
  const options: LlamaOptions = {
    model: env.MODEL_PATH ?? DEFAULT_MODEL,
    server: env.LLAMA_SERVER ?? DEFAULT_SERVER,
    host: "127.0.0.1",
    port: parsePort(env.PORT ?? "8080", "PORT"),
    context: parseContext(env.CONTEXT_SIZE ?? "64k"),
    cacheTypeK: env.KV_CACHE_TYPE_K ?? commonKv,
    cacheTypeV: env.KV_CACHE_TYPE_V ?? commonKv,
    gpuLayers: "all",
    flashAttention: true,
    batchSize: 1024,
    ubatchSize: 256,
    parallel: 1,
    mtpDraftTokens: parseNonNegativeInteger(env.MTP_DRAFT_TOKENS ?? "0", "MTP_DRAFT_TOKENS"),
    webui: true,
    dryRun: false,
    serverArgs,
  };

  let positionalModel: string | undefined;
  for (let index = 0; index < ownArgs.length; index++) {
    const arg = ownArgs[index];
    if (arg === "--help" || arg === "-h") throw new HelpRequested(llamaUsage());
    if (!arg.startsWith("-")) {
      if (positionalModel) throw new Error("Only one positional MODEL is accepted");
      positionalModel = arg;
      continue;
    }
    if (arg === "--no-webui") {
      options.webui = false;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    const value = takeValue(ownArgs, index, arg);
    index++;
    switch (arg) {
      case "--model":
        options.model = value;
        break;
      case "--server":
        options.server = value;
        break;
      case "--context":
        options.context = parseContext(value);
        break;
      case "--host":
        options.host = value;
        break;
      case "--port":
        options.port = parsePort(value, arg);
        break;
      case "--kv":
        options.cacheTypeK = value;
        options.cacheTypeV = value;
        break;
      case "--kv-k":
        options.cacheTypeK = value;
        break;
      case "--kv-v":
        options.cacheTypeV = value;
        break;
      case "--gpu-layers":
        options.gpuLayers = value;
        break;
      case "--batch-size":
        options.batchSize = parsePositiveInteger(value, arg);
        break;
      case "--ubatch-size":
        options.ubatchSize = parsePositiveInteger(value, arg);
        break;
      case "--parallel":
        options.parallel = parsePositiveInteger(value, arg);
        break;
      case "--mtp":
        options.mtpDraftTokens = parseNonNegativeInteger(value, arg);
        break;
      case "--mmproj":
        options.mmproj = value;
        break;
      default:
        throw new Error(`Unknown llama option: ${arg}`);
    }
  }
  if (positionalModel) options.model = positionalModel;
  return options;
}

export function buildLlamaArgs(options: LlamaOptions): string[] {
  return [
    "--model",
    options.model,
    "--host",
    options.host,
    "--port",
    String(options.port),
    ...(options.webui ? ["--webui"] : []),
    "--ctx-size",
    String(options.context),
    "--n-gpu-layers",
    options.gpuLayers,
    "--fit",
    "off",
    "--flash-attn",
    options.flashAttention ? "on" : "off",
    "--cache-type-k",
    options.cacheTypeK,
    "--cache-type-v",
    options.cacheTypeV,
    "--batch-size",
    String(options.batchSize),
    "--ubatch-size",
    String(options.ubatchSize),
    "--parallel",
    String(options.parallel),
    ...(options.mtpDraftTokens > 0
      ? ["--spec-type", "draft-mtp", "--spec-draft-n-max", String(options.mtpDraftTokens)]
      : []),
    ...(options.mmproj ? ["--mmproj", options.mmproj] : []),
    ...options.serverArgs,
  ];
}

export class HelpRequested extends Error {}

export async function assertFile(
  path: string,
  label: string,
  executable = false,
): Promise<void> {
  let info: Deno.FileInfo;
  try {
    info = await Deno.stat(path);
  } catch {
    throw new Error(`${label} not found: ${path}`);
  }
  if (!info.isFile) throw new Error(`${label} is not a file: ${path}`);
  if (executable && info.mode !== null && (info.mode & 0o111) === 0) {
    throw new Error(`${label} is not executable: ${path}`);
  }
}

export async function validateLlamaOptions(options: LlamaOptions): Promise<void> {
  await assertFile(options.model, "Model");
  await assertFile(options.server, "llama-server", true);
  if (options.mmproj) await assertFile(options.mmproj, "Vision projector");
}

export function spawnLlama(
  options: LlamaOptions,
  stdio: "inherit" | "piped" = "inherit",
): Deno.ChildProcess {
  return new Deno.Command(options.server, {
    args: buildLlamaArgs(options),
    cwd: options.server === "/usr/bin/llama-server" ? "/usr/lib" : undefined,
    stdin: "inherit",
    stdout: stdio,
    stderr: stdio,
  }).spawn();
}

export async function llamaCommand(args: string[]): Promise<void> {
  let options: LlamaOptions;
  try {
    options = parseLlamaArgs(args);
  } catch (error) {
    if (error instanceof HelpRequested) {
      console.log(error.message);
      return;
    }
    throw error;
  }

  await runLlama(options);
}

export async function runLlama(options: LlamaOptions): Promise<void> {
  const serverArgs = buildLlamaArgs(options);
  console.log(
    `llama-server: model=${options.model}, context=${options.context}, ` +
      `KV=${options.cacheTypeK}/${options.cacheTypeV}, port=${options.port}`,
  );
  if (options.dryRun) {
    console.log([options.server, ...serverArgs].map(shellQuote).join(" "));
    return;
  }

  await validateLlamaOptions(options);
  const child = spawnLlama(options);
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      child.kill("SIGTERM");
    } catch {
      return;
    }
  };
  Deno.addSignalListener("SIGINT", shutdown);
  Deno.addSignalListener("SIGTERM", shutdown);
  try {
    const status = await child.status;
    if (!status.success && !shuttingDown) Deno.exit(status.code);
  } finally {
    shutdown();
    Deno.removeSignalListener("SIGINT", shutdown);
    Deno.removeSignalListener("SIGTERM", shutdown);
    const termination = await terminateChild(child, 5000);
    if (termination === "killed") console.error("llama-server ignored SIGTERM and was killed");
  }
}

export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}
