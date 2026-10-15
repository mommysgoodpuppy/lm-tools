/**
 * One bounded OMP task with exactly two user-facing profiles.
 *
 * `paid` runs the machine's normal OMP configuration with its default paid
 * model; it never touches a free router. `free` runs zero-cost inference only:
 * a campaign-owned free-router session is started for exactly this task, the
 * lane must be eligible before OMP launches (fail closed, no paid fallback),
 * and the route configuration never materializes credentials.
 *
 * The task supervises its OMP process (timeout, cancellation, no orphans),
 * isolates per-task OMP session state, and returns an operational envelope
 * whose final text is whatever the model produced — nothing here interprets
 * the answer.
 */

import { join } from "jsr:@std/path@1";
import { parseOmpRpcEvents } from "./harness_attempt.ts";
import type { TokenUsage } from "./campaign.ts";
import { loadFreeRouterConfig } from "./free_router_server.ts";
import type { FreeRouterSession, FreeRouterSessionReceipt } from "./free_router_session.ts";
import { startFreeRouterSession } from "./free_router_session.ts";
import { buildOmpFreeRouterModelsYml } from "./free_router_omp.ts";
import { resolveManagedOmpExecutable } from "./omp_runtime.ts";

export type OmpTaskProfile = "free" | "paid";

export type OmpTaskTermination =
  | { kind: "completed"; exitCode: number }
  | { kind: "failed"; exitCode: number | null; error?: string }
  | { kind: "timeout"; exitCode: number | null }
  | { kind: "cancelled"; exitCode: number | null };

/** The concrete free route the task's traffic actually landed on, if any. */
export interface OmpTaskRoute {
  publicModel: string;
  offerId: string;
  adapter: string;
  provider: string;
  model: string;
  accessClass: string;
  at?: string;
}

export interface OmpTaskOptions {
  profile: OmpTaskProfile;
  /** Existing host directory the OMP process runs in. */
  cwd: string;
  prompt: string;
  /**
   * `free` only: a free-router service config (schemas/free-router.schema.json)
   * declaring the zero-priced lanes and the generic OMP gateway they resolve
   * through. Required for `free`, rejected for `paid`.
   */
  routerConfig?: string;
  /** OMP model override. `free` defaults to the router's first public model. */
  model?: string;
  /** Hard limit for the OMP process; default one hour. */
  timeoutMs?: number;
  /** External cancellation; kills OMP and shuts the router down as cancelled. */
  signal?: AbortSignal;
  /** Root for this task's operational artifacts. Default: <cwd>/.lm-task/<id>. */
  taskDirectory?: string;
  /** OMP executable override for tests. Production resolves lm-tools' managed pinned runtime. */
  ompExecutable?: string;
  /** Extra process environment for the OMP child; values must not contain NUL. */
  environment?: Readonly<Record<string, string>>;
}

export interface OmpTaskResult {
  profile: OmpTaskProfile;
  cwd: string;
  taskDirectory: string;
  startedAt: string;
  finishedAt: string;
  termination: OmpTaskTermination;
  /** Final assistant text; arbitrary model output, null when none was captured. */
  text: string | null;
  usage: TokenUsage;
  /** Selected concrete free route; null when nothing completed or profile paid. */
  route: OmpTaskRoute | null;
  /** Free-router session receipt; present only for the free profile. */
  router: FreeRouterSessionReceipt | null;
  exitCode: number | null;
  stderr: string;
  paths: {
    sessionDirectory: string;
    eventsPath: string;
    stderrPath: string;
    ompAgentDirectory?: string;
    routerDirectory?: string;
  };
}

export interface ParsedOmpTaskArgs {
  profile: OmpTaskProfile;
  cwd: string;
  routerConfig?: string;
  model?: string;
  prompt?: string;
  promptFile?: string;
  timeoutSeconds: number;
  json: boolean;
}

export function ompTaskUsage(): string {
  return `Usage: lm task --profile free|paid --cwd PATH [options]

Run one bounded OMP task. Exactly two profiles:

  paid  Normal OMP with the machine default paid model/config. The expected
        profile for code implementation and difficult bounded work. Never
        routed through a free router.
  free  Zero-cost inference only. Starts a campaign-owned free-router session
        from --router-config for exactly this task and fails closed if no lane
        is eligible. Intended for review, standing-claw style batch work, and
        mass tasks such as reverse engineering. Never falls back to paid.

Options:
  --cwd PATH              Working directory for the OMP process (required)
  --profile free|paid     Inference profile (required)
  --router-config PATH    Free-router service config; required for --profile
                          free, rejected for --profile paid
  --model ID              OMP model override (free defaults to the router lane)
  --prompt TEXT           Prompt text; mutually exclusive with --prompt-file
  --prompt-file PATH      Read the prompt from a file
  --timeout-seconds N     Hard OMP time limit (default 3600)
  --json                  Print the operational envelope as JSON instead of
                          the final answer text

Prompt precedence: at most one of --prompt or --prompt-file; when neither is
given the prompt is read from stdin. An empty prompt is an error.

Bearer credentials are only resolved through the configured OMP gateway and
are never written to disk or printed.`;
}

export function parseOmpTaskArgs(args: string[]): ParsedOmpTaskArgs {
  const parsed: ParsedOmpTaskArgs = { profile: "paid", cwd: "", timeoutSeconds: 3600, json: false };
  let hasProfile = false;
  let hasTimeout = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    const value = (): string => {
      index++;
      if (index >= args.length) throw new Error(`Missing value for ${arg}\n\n${ompTaskUsage()}`);
      return args[index]!;
    };
    switch (arg) {
      case "--profile": {
        const profile = value();
        if (profile !== "free" && profile !== "paid") {
          throw new Error(`Unknown task profile: ${profile} (expected free or paid)`);
        }
        parsed.profile = profile;
        hasProfile = true;
        break;
      }
      case "--cwd":
        parsed.cwd = value();
        break;
      case "--router-config":
        parsed.routerConfig = value();
        break;
      case "--model":
        parsed.model = value();
        break;
      case "--prompt":
        parsed.prompt = value();
        break;
      case "--prompt-file":
        parsed.promptFile = value();
        break;
      case "--timeout-seconds": {
        const seconds = Number(value());
        if (!Number.isFinite(seconds) || seconds <= 0) {
          throw new Error(`Invalid --timeout-seconds: ${seconds}`);
        }
        parsed.timeoutSeconds = seconds;
        hasTimeout = true;
        break;
      }
      case "--json":
        parsed.json = true;
        break;
      case "--help":
      case "-h":
        throw new Error("help-requested");
      default:
        throw new Error(`Unknown task option: ${arg}\n\n${ompTaskUsage()}`);
    }
  }
  if (!hasProfile) throw new Error("--profile free|paid is required\n\n" + ompTaskUsage());
  if (!parsed.cwd) throw new Error("--cwd PATH is required\n\n" + ompTaskUsage());
  if (parsed.prompt !== undefined && parsed.promptFile !== undefined) {
    throw new Error("--prompt and --prompt-file are mutually exclusive");
  }
  if (parsed.profile === "free" && !parsed.routerConfig) {
    throw new Error("--profile free requires --router-config\n\n" + ompTaskUsage());
  }
  if (parsed.profile === "paid" && parsed.routerConfig) {
    throw new Error(
      "--profile paid must not be routed through a free router; omit --router-config",
    );
  }
  if (!hasTimeout) parsed.timeoutSeconds = 3600;
  return parsed;
}

/**
 * Resolve the prompt text from parsed arguments. `stdinText` is the decoded
 * standard input; callers pass undefined when neither prompt flag was given
 * and stdin is a terminal.
 */
export async function resolveOmpTaskPrompt(
  parsed: Pick<ParsedOmpTaskArgs, "prompt" | "promptFile">,
  stdinText?: string,
): Promise<string> {
  if (parsed.prompt !== undefined) return validatePrompt(parsed.prompt, "--prompt");
  if (parsed.promptFile !== undefined) {
    return validatePrompt(await Deno.readTextFile(parsed.promptFile), parsed.promptFile);
  }
  if (stdinText === undefined) {
    throw new Error("A prompt is required: use --prompt, --prompt-file, or pipe it on stdin");
  }
  return validatePrompt(stdinText, "stdin");
}

function validatePrompt(prompt: string, source: string): string {
  if (prompt.trim().length === 0) throw new Error(`Prompt from ${source} is empty`);
  return prompt;
}

function taskIdentity(): string {
  return new Date().toISOString().replaceAll(":", "").replaceAll(".", "-") +
    `-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Run one bounded OMP task. The process is supervised: a hard timeout and an
 * external abort signal both terminate OMP (TERM, then KILL after a 30s
 * grace), so no orphan survives either path. A free task owns its router for
 * exactly the task duration.
 */
export async function runOmpTask(options: OmpTaskOptions): Promise<OmpTaskResult> {
  if (options.profile === "free" && !options.routerConfig) {
    throw new Error("The free profile requires routerConfig");
  }
  if (options.profile === "paid" && options.routerConfig) {
    throw new Error("The paid profile must not start a free router");
  }
  const cwdStat = await Deno.stat(options.cwd).catch(() => undefined);
  if (!cwdStat?.isDirectory) throw new Error(`Task --cwd is not a directory: ${options.cwd}`);
  const prompt = validatePrompt(options.prompt, "options.prompt");

  const taskDirectory = options.taskDirectory ?? join(options.cwd, ".lm-task", taskIdentity());
  await Deno.mkdir(taskDirectory, { recursive: true });
  const sessionDirectory = join(taskDirectory, "omp-session");
  const eventsPath = join(taskDirectory, "events.jsonl");
  const stderrPath = join(taskDirectory, "stderr.log");

  if (options.profile === "paid") {
    return await runSupervisedOmp(options, {
      taskDirectory,
      sessionDirectory,
      eventsPath,
      stderrPath,
      prompt,
      agentDirectory: undefined,
    });
  }

  const config = await loadFreeRouterConfig(options.routerConfig!);
  const publicModel = options.model ?? config.models[0]!.id;
  const agentDirectory = join(taskDirectory, "omp-agent");
  await Deno.mkdir(agentDirectory, { recursive: true });
  const routerDirectory = join(taskDirectory, "router");

  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onExternalAbort, { once: true });

  let session: FreeRouterSession | undefined;
  try {
    // Fail closed: if no declared lane is eligible at readiness, this throws
    // and the task never launches OMP at all — there is no paid fallback.
    session = await startFreeRouterSession({
      listen: config.listen,
      models: config.models,
      policy: config.policy,
      ompGateway: {
        baseUrl: config.omp.baseUrl,
        bearerTokenFile: config.omp.resolvedBearerTokenFile,
      },
      artifactsDirectory: routerDirectory,
      signal: controller.signal,
    });
    await Deno.writeTextFile(
      join(agentDirectory, "models.yml"),
      buildOmpFreeRouterModelsYml(config, {
        baseUrl: session.baseUrl,
        publicModel,
      }),
      { createNew: true },
    );

    const result = await runSupervisedOmp(options, {
      taskDirectory,
      sessionDirectory,
      eventsPath,
      stderrPath,
      prompt,
      agentDirectory,
      model: publicModel,
    });

    result.route = await captureRoute(session);
    result.router = session.receipt();
    result.paths.routerDirectory = routerDirectory;
    result.paths.ompAgentDirectory = agentDirectory;
    await session.shutdown(result.termination.kind === "completed" ? "explicit" : "failure");
    result.router = session.receipt();
    return result;
  } catch (error) {
    await session?.shutdown("failure");
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", onExternalAbort);
  }
}

/** Credential-free concrete route status from the task's own router session. */
async function captureRoute(
  session: FreeRouterSession,
): Promise<OmpTaskRoute | null> {
  const url = `${session.baseUrl}/free-router/status`;
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) }).catch(() => undefined);
  if (!response?.ok) return null;
  const status = await response.json() as {
    lastCompleted?: {
      publicModel?: string;
      offerId?: string;
      adapter?: string;
      provider?: string;
      model?: string;
      accessClass?: string;
      at?: string;
    } | null;
  };
  const last = status.lastCompleted;
  if (!last || !last.publicModel || !last.offerId || !last.adapter || !last.provider) return null;
  return {
    publicModel: last.publicModel,
    offerId: last.offerId,
    adapter: last.adapter,
    provider: last.provider,
    model: last.model ?? "",
    accessClass: last.accessClass ?? "",
    ...(last.at ? { at: last.at } : {}),
  };
}

async function runSupervisedOmp(
  options: OmpTaskOptions,
  layout: {
    taskDirectory: string;
    sessionDirectory: string;
    eventsPath: string;
    stderrPath: string;
    prompt: string;
    agentDirectory?: string;
    model?: string;
  },
): Promise<OmpTaskResult> {
  const startedAt = new Date().toISOString();
  const timeoutMs = options.timeoutMs ?? 3_600_000;
  const executable = options.ompExecutable ??
    Deno.env.get("LM_TOOLS_OMP_EXECUTABLE") ?? await resolveManagedOmpExecutable();
  const argv = [
    "--mode",
    "json",
    "--no-lsp",
    ...((layout.model ?? options.model) ? ["--model", (layout.model ?? options.model)!] : []),
    "--session-dir",
    layout.sessionDirectory,
  ];

  const environment: Record<string, string> = {
    ...Deno.env.toObject(),
    ...(options.environment ?? {}),
  };
  if (layout.agentDirectory) environment.PI_CODING_AGENT_DIR = layout.agentDirectory;

  const command = new Deno.Command(executable, {
    args: argv,
    cwd: options.cwd,
    env: environment,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = command.spawn();
  const stdin = child.stdin.getWriter();
  await stdin.write(new TextEncoder().encode(layout.prompt));
  await stdin.close();

  // Supervision: timeout or external cancellation both terminate OMP. TERM
  // first, KILL after a grace period, so the process can never outlive the
  // task and orphan itself.
  const timers: ReturnType<typeof setTimeout>[] = [];
  let finished = false;
  let supervisorAction: "timeout" | "cancelled" | null = null;
  const terminate = (graceMs: number, action: "timeout" | "cancelled") => {
    supervisorAction = action;
    try {
      child.kill("SIGTERM");
    } catch {
      // Already exited.
    }
    timers.push(setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already exited.
      }
    }, graceMs));
  };
  const timeoutHandle = setTimeout(() => terminate(30_000, "timeout"), timeoutMs);
  const abortListener = () => {
    if (!finished) terminate(5_000, "cancelled");
  };
  options.signal?.addEventListener("abort", abortListener, { once: true });
  if (options.signal?.aborted) abortListener();

  // The child may leave grandchildren (sleeps, tool subprocesses) holding the
  // stdio pipes open; on termination we cancel both streams instead of waiting
  // for them to close naturally.
  const stderrFile = await Deno.open(layout.stderrPath, {
    createNew: true,
    write: true,
    mode: 0o600,
  });
  const stderrChunks: Uint8Array[] = [];
  const stderrTask = (async () => {
    const reader = child.stderr.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        stderrChunks.push(value);
        await stderrFile.write(value);
      }
    } catch {
      // Stream cancelled during termination.
    } finally {
      stderrFile.close();
    }
  })();

  const eventsFile = await Deno.open(layout.eventsPath, {
    createNew: true,
    write: true,
    mode: 0o600,
  });
  const lines: string[] = [];
  let pending = "";
  const stdoutTask = (async () => {
    const decoder = new TextDecoder();
    const reader = child.stdout.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        let newline = pending.indexOf("\n");
        while (newline >= 0) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          lines.push(line);
          await eventsFile.write(new TextEncoder().encode(`${line}\n`));
          newline = pending.indexOf("\n");
        }
      }
    } catch {
      // Stream cancelled during termination.
    } finally {
      if (pending) lines.push(pending);
      eventsFile.close();
    }
  })();

  const status = await child.status;
  finished = true;
  clearTimeout(timeoutHandle);
  for (const timer of timers) clearTimeout(timer);
  options.signal?.removeEventListener("abort", abortListener);
  // A terminated child can leave grandchildren holding the stdio pipes, so the
  // readers get a bounded window before a forced cancel.
  await Promise.race([
    Promise.allSettled([stderrTask, stdoutTask]),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  await child.stdout.cancel().catch(() => {});
  await child.stderr.cancel().catch(() => {});
  const finishedAt = new Date().toISOString();

  let stderrLength = 0;
  const stderrTail: string[] = [];
  for (let index = stderrChunks.length - 1; index >= 0 && stderrLength < 16_000; index--) {
    const text = new TextDecoder().decode(stderrChunks[index]!);
    stderrTail.unshift(text);
    stderrLength += text.length;
  }
  const stderr = stderrTail.join("");
  const parsed = parseOmpRpcEvents(lines);
  const termination: OmpTaskTermination = supervisorAction === "cancelled"
    ? { kind: "cancelled", exitCode: status.code }
    : supervisorAction === "timeout"
    ? { kind: "timeout", exitCode: status.code }
    : status.success
    ? { kind: "completed", exitCode: status.code }
    : { kind: "failed", exitCode: status.code };

  const usage: TokenUsage = parsed.usage;
  const result: OmpTaskResult = {
    profile: options.profile,
    cwd: options.cwd,
    taskDirectory: layout.taskDirectory,
    startedAt,
    finishedAt,
    termination,
    text: parsed.finalMessage,
    usage,
    route: null,
    router: null,
    exitCode: status.code,
    stderr,
    paths: {
      sessionDirectory: layout.sessionDirectory,
      eventsPath: layout.eventsPath,
      stderrPath: layout.stderrPath,
      ...(layout.agentDirectory ? { ompAgentDirectory: layout.agentDirectory } : {}),
    },
  };
  await Deno.writeTextFile(
    join(layout.taskDirectory, "task-result.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  return result;
}

export async function taskCommand(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(ompTaskUsage());
    return;
  }
  let parsed: ParsedOmpTaskArgs;
  try {
    parsed = parseOmpTaskArgs(args);
  } catch (error) {
    if (error instanceof Error && error.message === "help-requested") {
      console.log(ompTaskUsage());
      return;
    }
    throw error;
  }
  const stdinText = parsed.prompt === undefined && parsed.promptFile === undefined
    ? (Deno.stdin.isTerminal() ? undefined : await new Response(Deno.stdin.readable).text())
    : undefined;
  const prompt = await resolveOmpTaskPrompt(parsed, stdinText);
  const result = await runOmpTask({
    profile: parsed.profile,
    cwd: parsed.cwd,
    prompt,
    routerConfig: parsed.routerConfig,
    model: parsed.model,
    timeoutMs: parsed.timeoutSeconds * 1000,
  });
  if (parsed.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (result.text === null) {
      console.error(
        `lm task ${result.profile}: ${result.termination.kind}; no final text. ` +
          `Operational record: ${result.taskDirectory}`,
      );
    }
    console.log(result.text ?? "");
  }
  if (result.termination.kind !== "completed") Deno.exitCode = 1;
}
