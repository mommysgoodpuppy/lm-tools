import { dirname, join } from "jsr:@std/path@1";
import type { ResolvedAgentEnvironment } from "./agent_environment.ts";

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

interface RepositorySnapshot {
  head: string;
  status: string;
}

interface WorkerRun {
  id: string;
  startedAt: string;
  finishedAt: string;
  durationSeconds: number;
  exitCode: number;
  timedOut: boolean;
  usage: TokenUsage;
  eventLog: string;
  stateBefore: string | null;
  stateAfter: string | null;
  repositoriesBefore: Record<string, RepositorySnapshot>;
  repositoriesAfter: Record<string, RepositorySnapshot>;
  finalMessage: string | null;
}

interface CampaignLedger {
  version: 1;
  environment: string;
  startedAt: string;
  updatedAt: string;
  runs: number;
  successfulRuns: number;
  failedRuns: number;
  wallSeconds: number;
  usage: TokenUsage;
  history: WorkerRun[];
}

const ZERO_USAGE: TokenUsage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
};

function numberField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function parseCodexEventUsage(lines: string[]): {
  usage: TokenUsage;
  finalMessage: string | null;
} {
  const usage = { ...ZERO_USAGE };
  let finalMessage: string | null = null;
  let appServerUsage: TokenUsage | null = null;
  for (const line of lines) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.type === "turn.completed") {
      const raw = (event.usage ?? {}) as Record<string, unknown>;
      usage.inputTokens += numberField(raw.input_tokens);
      usage.cachedInputTokens += numberField(raw.cached_input_tokens);
      usage.outputTokens += numberField(raw.output_tokens);
    }
    if (event.type === "item.completed") {
      const item = event.item as Record<string, unknown> | undefined;
      if (item?.type === "agent_message" && typeof item.text === "string") {
        finalMessage = item.text;
      }
    }
    if (event.method === "thread/tokenUsage/updated") {
      const params = (event.params ?? {}) as Record<string, unknown>;
      const tokenUsage = (params.tokenUsage ?? {}) as Record<string, unknown>;
      const total = (tokenUsage.total ?? {}) as Record<string, unknown>;
      appServerUsage = {
        inputTokens: numberField(total.inputTokens),
        cachedInputTokens: numberField(total.cachedInputTokens),
        outputTokens: numberField(total.outputTokens),
        totalTokens: numberField(total.totalTokens),
      };
    }
    if (event.method === "item/completed") {
      const params = (event.params ?? {}) as Record<string, unknown>;
      const item = params.item as Record<string, unknown> | undefined;
      if (item?.type === "agentMessage" && typeof item.text === "string") {
        finalMessage = item.text;
      }
    }
  }
  if (appServerUsage) return { usage: appServerUsage, finalMessage };
  usage.totalTokens = usage.inputTokens + usage.outputTokens;
  return { usage, finalMessage };
}

type JsonObject = Record<string, unknown>;

function jsonObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

async function writeRpc(writer: WritableStreamDefaultWriter<Uint8Array>, message: unknown) {
  await writer.write(new TextEncoder().encode(`${JSON.stringify(message)}\n`));
}

async function handleServerRequest(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  message: JsonObject,
): Promise<void> {
  if (!("id" in message) || typeof message.method !== "string") return;
  if (
    message.method === "item/commandExecution/requestApproval" ||
    message.method === "item/fileChange/requestApproval"
  ) {
    await writeRpc(writer, { id: message.id, result: { decision: "acceptForSession" } });
    return;
  }
  if (message.method === "item/tool/requestUserInput") {
    await writeRpc(writer, { id: message.id, result: { answers: {} } });
    return;
  }
  await writeRpc(writer, {
    id: message.id,
    error: { code: -32601, message: `Unsupported autonomous worker request: ${message.method}` },
  });
}

async function runAppServerTurn(
  environment: ResolvedAgentEnvironment,
  prompt: string,
  eventLog: string,
): Promise<{ exitCode: number; timedOut: boolean; lines: string[] }> {
  const worker = workerConfig(environment);
  const { backend, guest } = environment.config;
  const command = new Deno.Command("/usr/bin/timeout", {
    args: [
      "--signal=TERM",
      "--kill-after=30s",
      String(worker.timeoutSeconds),
      backend.executable,
      "exec",
      "-T",
      "--user",
      String(guest.uid),
      "--group",
      String(guest.gid),
      "--cwd",
      guest.workspace,
      "--env",
      `HOME=${guest.home}`,
      backend.instance,
      "--",
      "codex",
      "app-server",
      "--listen",
      "stdio://",
    ],
    stdin: "piped",
    stdout: "piped",
    stderr: "inherit",
  }).spawn();
  const writer = command.stdin.getWriter();
  const raw = await Deno.open(eventLog, { createNew: true, write: true });
  const lines: string[] = [];
  const decoder = new TextDecoder();
  let pending = "";
  let turnStatus: string | null = null;
  let writerClosed = false;

  await writeRpc(writer, {
    method: "initialize",
    id: 1,
    params: {
      clientInfo: {
        name: "lm_tools_worker",
        title: "lm-tools autonomous worker",
        version: "0.1.0",
      },
    },
  });

  const processLine = async (line: string) => {
    if (!line) return;
    lines.push(line);
    await raw.write(new TextEncoder().encode(`${line}\n`));
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    const message = jsonObject(parsed);
    if (!message) return;
    if (message.error && (message.id === 1 || message.id === 2 || message.id === 3)) {
      throw new Error(
        `Codex app-server request ${message.id} failed: ${JSON.stringify(message.error)}`,
      );
    }
    if (message.id === 1) {
      await writeRpc(writer, { method: "initialized", params: {} });
      await writeRpc(writer, {
        method: "thread/start",
        id: 2,
        params: {
          cwd: guest.workspace,
          approvalPolicy: "never",
          sandbox: "danger-full-access",
          ephemeral: true,
          serviceName: "lm_tools_worker",
        },
      });
      return;
    }
    if (message.id === 2) {
      const result = jsonObject(message.result);
      const thread = jsonObject(result?.thread);
      if (typeof thread?.id !== "string") throw new Error("thread/start returned no thread id");
      await writeRpc(writer, {
        method: "turn/start",
        id: 3,
        params: {
          threadId: thread.id,
          input: [{ type: "text", text: prompt }],
          cwd: guest.workspace,
          approvalPolicy: "never",
          sandboxPolicy: { type: "dangerFullAccess" },
        },
      });
      return;
    }
    if (message.method === "turn/completed") {
      const params = jsonObject(message.params);
      const turn = jsonObject(params?.turn);
      turnStatus = typeof turn?.status === "string" ? turn.status : "failed";
      if (!writerClosed) {
        writerClosed = true;
        await writer.close();
      }
      return;
    }
    await handleServerRequest(writer, message);
  };

  try {
    for await (const chunk of command.stdout) {
      pending += decoder.decode(chunk, { stream: true });
      const split = pending.split("\n");
      pending = split.pop() ?? "";
      for (const line of split) await processLine(line);
    }
    pending += decoder.decode();
    if (pending) await processLine(pending);
  } finally {
    raw.close();
    if (!writerClosed) {
      writerClosed = true;
      await writer.close().catch(() => undefined);
    }
  }
  const status = await command.status;
  const timedOut = status.code === 124;
  return {
    exitCode: !timedOut && turnStatus === "completed" ? 0 : status.code || 1,
    timedOut,
    lines,
  };
}

async function runExecJsonTurn(
  environment: ResolvedAgentEnvironment,
  prompt: string,
  eventLog: string,
): Promise<{ exitCode: number; timedOut: boolean; lines: string[] }> {
  const worker = workerConfig(environment);
  const { backend, guest } = environment.config;
  const command = new Deno.Command("/usr/bin/timeout", {
    args: [
      "--signal=TERM",
      "--kill-after=30s",
      String(worker.timeoutSeconds),
      backend.executable,
      "exec",
      "-T",
      "--user",
      String(guest.uid),
      "--group",
      String(guest.gid),
      "--cwd",
      guest.workspace,
      "--env",
      `HOME=${guest.home}`,
      backend.instance,
      "--",
      "codex",
      "exec",
      "--strict-config",
      "--json",
      "--ephemeral",
      "-C",
      guest.workspace,
      "-",
    ],
    stdin: "piped",
    stdout: "piped",
    stderr: "inherit",
  }).spawn();
  const writer = command.stdin.getWriter();
  await writer.write(new TextEncoder().encode(prompt));
  await writer.close();

  const raw = await Deno.open(eventLog, { createNew: true, write: true });
  const lines: string[] = [];
  const decoder = new TextDecoder();
  let pending = "";
  try {
    for await (const chunk of command.stdout) {
      await raw.write(chunk);
      pending += decoder.decode(chunk, { stream: true });
      const split = pending.split("\n");
      pending = split.pop() ?? "";
      lines.push(...split);
    }
    pending += decoder.decode();
    if (pending) lines.push(pending);
  } finally {
    raw.close();
  }
  const status = await command.status;
  return { exitCode: status.code, timedOut: status.code === 124, lines };
}

function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  };
}

async function guestOutput(
  environment: ResolvedAgentEnvironment,
  command: string[],
): Promise<string | null> {
  const { backend, guest } = environment.config;
  const output = await new Deno.Command(backend.executable, {
    args: [
      "exec",
      "-T",
      "--user",
      String(guest.uid),
      "--group",
      String(guest.gid),
      "--cwd",
      guest.workspace,
      "--env",
      `HOME=${guest.home}`,
      backend.instance,
      "--",
      ...command,
    ],
    stdin: "null",
    stdout: "piped",
    stderr: "null",
  }).output();
  return output.success ? new TextDecoder().decode(output.stdout).trim() : null;
}

async function stateHash(
  environment: ResolvedAgentEnvironment,
  statePath: string,
): Promise<string | null> {
  const output = await guestOutput(environment, ["sha256sum", statePath]);
  return output?.split(/\s+/, 1)[0] ?? null;
}

async function repositorySnapshots(
  environment: ResolvedAgentEnvironment,
  repositories: string[],
): Promise<Record<string, RepositorySnapshot>> {
  const snapshots: Record<string, RepositorySnapshot> = {};
  for (const repository of repositories) {
    snapshots[repository] = {
      head: (await guestOutput(environment, ["git", "-C", repository, "rev-parse", "HEAD"])) ??
        "unavailable",
      status:
        (await guestOutput(environment, ["git", "-C", repository, "status", "--porcelain=v1"])) ??
          "unavailable",
    };
  }
  return snapshots;
}

async function cleanWorkerProcesses(
  environment: ResolvedAgentEnvironment,
  processNames: string[],
): Promise<void> {
  for (const name of processNames) {
    await guestOutput(environment, ["pkill", "-TERM", "-x", name]);
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await Deno.mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await Deno.writeTextFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await Deno.rename(temporary, path);
}

async function updateLedger(
  path: string,
  environmentName: string,
  run: WorkerRun,
): Promise<CampaignLedger> {
  let ledger: CampaignLedger | undefined;
  try {
    ledger = JSON.parse(await Deno.readTextFile(path)) as CampaignLedger;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  ledger ??= {
    version: 1,
    environment: environmentName,
    startedAt: run.startedAt,
    updatedAt: run.finishedAt,
    runs: 0,
    successfulRuns: 0,
    failedRuns: 0,
    wallSeconds: 0,
    usage: { ...ZERO_USAGE },
    history: [],
  };
  ledger.updatedAt = run.finishedAt;
  ledger.runs += 1;
  if (run.exitCode === 0) ledger.successfulRuns += 1;
  else ledger.failedRuns += 1;
  ledger.wallSeconds += run.durationSeconds;
  ledger.usage = addUsage(ledger.usage, run.usage);
  ledger.history.push(run);
  await writeJsonAtomic(path, ledger);
  return ledger;
}

function workerConfig(environment: ResolvedAgentEnvironment) {
  const worker = environment.config.worker;
  if (!worker) throw new Error("This agent environment does not declare a worker");
  return worker;
}

export async function runWorkerOnce(
  environment: ResolvedAgentEnvironment,
): Promise<{ run: WorkerRun; ledger: CampaignLedger }> {
  const worker = workerConfig(environment);
  const started = new Date();
  const id = started.toISOString().replaceAll(":", "").replaceAll(".", "-");
  await Deno.mkdir(worker.metricsDirectory, { recursive: true });
  const eventLog = join(worker.metricsDirectory, `${id}.jsonl`);
  const currentPath = join(worker.metricsDirectory, "current.json");
  await writeJsonAtomic(currentPath, {
    id,
    status: "starting",
    startedAt: started.toISOString(),
    eventLog,
    prompt: worker.prompt,
    state: worker.state,
    transport: worker.transport,
  });
  const prompt = await guestOutput(environment, ["cat", worker.prompt]);
  if (prompt === null) throw new Error(`Could not read guest worker prompt: ${worker.prompt}`);
  const repositoriesBefore = await repositorySnapshots(
    environment,
    worker.progressRepositories,
  );
  const stateBefore = await stateHash(environment, worker.state);

  await writeJsonAtomic(currentPath, {
    id,
    status: "running",
    startedAt: started.toISOString(),
    eventLog,
    prompt: worker.prompt,
    state: worker.state,
    transport: worker.transport,
  });
  const result = worker.transport === "app-server"
    ? await runAppServerTurn(environment, prompt, eventLog)
    : await runExecJsonTurn(environment, prompt, eventLog);
  await cleanWorkerProcesses(environment, worker.cleanupProcesses);
  const finished = new Date();
  const parsed = parseCodexEventUsage(result.lines);
  const run: WorkerRun = {
    id,
    startedAt: started.toISOString(),
    finishedAt: finished.toISOString(),
    durationSeconds: (finished.getTime() - started.getTime()) / 1000,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    usage: parsed.usage,
    eventLog,
    stateBefore,
    stateAfter: await stateHash(environment, worker.state),
    repositoriesBefore,
    repositoriesAfter: await repositorySnapshots(environment, worker.progressRepositories),
    finalMessage: parsed.finalMessage,
  };
  await writeJsonAtomic(join(worker.metricsDirectory, `${id}.json`), run);
  const ledger = await updateLedger(
    join(worker.metricsDirectory, "campaign.json"),
    environment.config.name,
    run,
  );
  await writeJsonAtomic(currentPath, {
    id,
    status: "finished",
    startedAt: started.toISOString(),
    finishedAt: finished.toISOString(),
    exitCode: run.exitCode,
    eventLog,
    report: join(worker.metricsDirectory, `${id}.json`),
  });
  return { run, ledger };
}

export async function runWorkerLoop(environment: ResolvedAgentEnvironment): Promise<never> {
  const worker = workerConfig(environment);
  while (true) {
    try {
      const { run, ledger } = await runWorkerOnce(environment);
      console.log(
        `Worker ${run.id}: exit=${run.exitCode}, ${run.durationSeconds.toFixed(1)}s, ` +
          `${run.usage.totalTokens.toLocaleString("en-US")} tokens; campaign ` +
          `${ledger.runs} runs / ${ledger.usage.totalTokens.toLocaleString("en-US")} tokens`,
      );
      if (run.finalMessage) console.log(run.finalMessage.trim());
    } catch (error) {
      console.error(`Worker turn failed before it could be recorded: ${error}`);
    }
    await new Promise((resolve) => setTimeout(resolve, worker.cooldownSeconds * 1000));
  }
}
