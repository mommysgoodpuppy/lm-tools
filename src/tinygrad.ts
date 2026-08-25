import { parsePositiveInteger, takeValue } from "./args.ts";
import { checkVendorManifest, loadVendorManifest } from "./vendor.ts";

const DEFAULT_QWEN = "/home/ellie/.cache/lm-tools/models/Qwen3.8-27B-IQ4_XS.gguf";

export interface TinygradOptions {
  python: string;
  device: string;
  jit: number;
  recurrentChunk?: number;
  tinygradArgs: string[];
}

export function tinygradUsage(): string {
  return `lm tinygrad — experimental vendored tinygrad LLM runner

Usage:
  lm tinygrad [MODEL] [tinygrad options]
  lm tinygrad --recurrent-chunk N [MODEL] [tinygrad options]

lm-tools options:
  --device NAME          tinygrad device (default: AMD)
  --jit N                tinygrad JIT mode (default: 1)
  --python PATH          Python interpreter (default: python3)
  --recurrent-chunk N    opt in to chunked Qwen 3.5+ recurrent prefill
  --                     pass all remaining arguments to tinygrad

If MODEL is omitted, the Qwen3.8-27B IQ4_XS selected for the pinned RDNA3
kernel path is used. All other
arguments are passed to tinygrad.llm; for example:

  lm tinygrad --max_context 4096 --benchmark 5
  lm tinygrad --recurrent-chunk 16 --max_context 4096 --serve 8000

JITBEAM is intentionally not enabled: its gfx1100 kernel search caused an AMD
queue timeout and a hard system reset during the initial investigation.`;
}

export function parseTinygradArgs(
  args: string[],
  env: Record<string, string | undefined> = Deno.env.toObject(),
): TinygradOptions {
  const tinygradArgs: string[] = [];
  let python = env.TINYGRAD_PYTHON ?? "python3";
  let device = env.TINYGRAD_DEVICE ?? "AMD";
  let jit = parsePositiveInteger(env.TINYGRAD_JIT ?? "1", "TINYGRAD_JIT");
  let recurrentChunk: number | undefined;
  let hasModel = false;
  let passthrough = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (passthrough) {
      tinygradArgs.push(arg);
      continue;
    }
    switch (arg) {
      case "--":
        passthrough = true;
        break;
      case "--python":
        python = takeValue(args, i++, arg);
        break;
      case "--device":
        device = takeValue(args, i++, arg);
        break;
      case "--jit":
        jit = parsePositiveInteger(takeValue(args, i++, arg), arg);
        break;
      case "--recurrent-chunk":
        recurrentChunk = parsePositiveInteger(takeValue(args, i++, arg), arg);
        break;
      case "--model":
      case "-m":
        tinygradArgs.push(arg, takeValue(args, i++, arg));
        hasModel = true;
        break;
      case "--max_context":
        tinygradArgs.push(arg, takeValue(args, i++, arg));
        break;
      case "--serve":
      case "--benchmark":
        tinygradArgs.push(arg);
        if (args[i + 1] !== undefined && !args[i + 1].startsWith("-")) {
          tinygradArgs.push(args[++i]);
        }
        break;
      default:
        if (!arg.startsWith("-") && !hasModel) {
          tinygradArgs.push("--model", arg);
          hasModel = true;
        } else tinygradArgs.push(arg);
    }
  }

  if (!hasModel) {
    tinygradArgs.unshift("--model", env.TINYGRAD_MODEL ?? DEFAULT_QWEN);
  }
  return { python, device, jit, recurrentChunk, tinygradArgs };
}

export function buildTinygradCommand(options: TinygradOptions, projectRoot: string) {
  const vendorRoot = `${projectRoot}/vendor/tinygrad`;
  const env: Record<string, string> = {
    DEV: options.device,
    JIT: String(options.jit),
    PYTHONPATH: vendorRoot,
    PYTHONUNBUFFERED: "1",
  };
  if (options.recurrentChunk !== undefined) {
    env.TINYGRAD_RECURRENT_CHUNK_SIZE = String(options.recurrentChunk);
  }
  return {
    command: options.python,
    args: ["-m", "tinygrad.llm", ...options.tinygradArgs],
    env,
  };
}

export async function tinygradCommand(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(tinygradUsage());
    return;
  }
  const projectRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
  try {
    await checkVendorManifest(
      await loadVendorManifest(`${projectRoot}/vendors/tinygrad-rdna3-qwen.json`),
    );
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : error}; run deno task tinygrad:vendor`,
    );
  }
  const spec = buildTinygradCommand(parseTinygradArgs(args), projectRoot);
  const command = new Deno.Command(spec.command, {
    args: spec.args,
    env: spec.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const status = await command.spawn().status;
  if (!status.success) throw new Error(`tinygrad exited with status ${status.code}`);
}
