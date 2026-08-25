import { Ajv2020, type ErrorObject } from "npm:ajv@8.17.1/dist/2020.js";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "jsr:@std/path@1";
import { loadAgentEnvironment, type ResolvedAgentEnvironment } from "./agent_environment.ts";
import { runWorkerOnce } from "./agent_worker.ts";
import { terminateChild, terminatePid } from "./process_manager.ts";

const PROJECT_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const CAMPAIGN_SCHEMA = `${PROJECT_ROOT}/schemas/campaign.schema.json`;
const DEFAULT_CAMPAIGN = `${PROJECT_ROOT}/campaigns/qwen-tinygrad.json`;

type Phase =
  | "PAUSED"
  | "WORKER_READY"
  | "WORKER_RUNNING"
  | "CANDIDATE_EXPORTED"
  | "VULKAN_STOPPING"
  | "GPU_QUIESCENT"
  | "EVALUATING"
  | "RESULT_RECORDED"
  | "VULKAN_STARTING";

interface CommandConfig {
  argv: string[];
  environment: Record<string, string>;
}

interface ProbeRunnerConfig {
  name: string;
  executable: string;
  allowedPathPrefixes: string[];
  timeoutSeconds: number;
  environment: Record<string, string>;
}

interface TierConfig {
  name: string;
  maxInputChars?: number;
  expectedPromptTokens: number;
  maxOutputTokens: number;
  repeats: number;
  candidateBaselineWallMs: number;
  competitorWallMs: number;
  promoteBelowParentPercent?: number;
  expectedOutputSha256: string;
}

interface CampaignConfig {
  $schema?: string;
  version: 1;
  name: string;
  objective: string;
  environment: string;
  harness: { kind: "codex-app-server" | "pi-rpc" };
  loop: {
    successCooldownSeconds: number;
    failureCooldownSeconds: number;
    restartRequestPath: string;
    pausePath?: string;
    controllerService?: string;
  };
  workspace: {
    guestCheckout: string;
    guestEvaluationRequest: string;
    guestEvaluationResult: string;
    guestEvaluationArtifactsDirectory: string;
    hostBaseCheckout: string;
    candidatesDirectory: string;
  };
  resources: {
    lockPath: string;
    journalPath: string;
    workerServices: string[];
    workerReadyUrls: string[];
    shutdownTimeoutSeconds: number;
    vram: { devicePath: string; quiescentMaxMiB: number; peakMaxMiB: number };
    ports: number[];
  };
  evaluator: {
    python: string;
    device: string;
    jit: number;
    model: {
      path: string;
      size: number;
      sha256: string;
      metadata: { hostPath: string; guestPath: string; command: CommandConfig };
    };
    contextWindow: number;
    listenPort: number;
    startupTimeoutSeconds: number;
    request: { path: string; api: "responses" | "chat-completions" };
    unitCommands: CommandConfig[];
    probeRunners: ProbeRunnerConfig[];
    allowedRequestEnvironment: string[];
    tiers: TierConfig[];
  };
}

export interface ResolvedCampaign {
  sourcePath: string;
  config: CampaignConfig;
  environment: ResolvedAgentEnvironment;
}

interface AcceptedCandidate {
  path: string;
  hash: string;
  metrics: Record<string, number>;
}

interface CampaignJournal {
  version: 1;
  campaign: string;
  phase: Phase;
  updatedAt: string;
  cycle: number;
  accepted: AcceptedCandidate;
  activeCandidate?: { id: string; path: string; hash: string };
  lastResult?: string;
  lastError?: string;
}

interface EvaluationRequest {
  version: 1;
  kind: "benchmark" | "profile" | "probe";
  tier?: string;
  focus?: string;
  environment?: Record<string, string>;
  probe?: { runner: string; path: string };
}

interface ProbeResult {
  runner: string;
  path: string;
  argv: string[];
  exitCode: number;
  timedOut: boolean;
  wallMs: number;
  stdoutLog: string;
  stderrLog: string;
  profile?: TinygradProfileSummary;
  executionSucceeded: boolean;
}

interface TierRun {
  resultPath: string;
  wallMs: number;
  promptTokens: number;
  completionTokens: number;
  peakVramMiB?: number;
  outputSha256: string;
  passed: boolean;
  failures: string[];
}

interface TierEvaluation {
  name: string;
  runs: TierRun[];
  medianWallMs: number;
  parentWallMs: number;
  competitorWallMs: number;
  improvementPercent: number;
  passed: boolean;
  earnedNext: boolean;
}

interface KernelProfileEntry {
  name: string;
  count: number;
  totalMs: number;
  averageMs: number;
  percentKernelTime: number;
}

export interface TinygradProfileSummary {
  sourceLog: string;
  scope: "after-server-start" | "whole-log";
  opaqueGraphReplay: boolean;
  kernelCount: number;
  kernelTimeMs: number;
  families: KernelProfileEntry[];
  topKernels: KernelProfileEntry[];
}

interface EvaluationResult {
  version: 1;
  campaign: string;
  candidate: { id: string; path: string; hash: string };
  startedAt: string;
  finishedAt: string;
  request?: EvaluationRequest;
  profile?: TinygradProfileSummary;
  probe?: ProbeResult;
  unitCommands: Array<{ argv: string[]; exitCode: number; log: string }>;
  tiers: TierEvaluation[];
  accepted: boolean;
  failure?: string;
}

export function classifyEvaluatorFailure(failure: string, stderr: string): string {
  const hardwareFault = stderr.match(/RuntimeError: (?:HW|MMU) fault:[^\n]+/i)?.[0];
  return hardwareFault
    ? `AMD GPU fault during candidate execution: ${hardwareFault.replace(/^RuntimeError:\s*/, "")}`
    : failure;
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? []).map((error) => {
    const location = error.instancePath || "/";
    return `${location}: ${error.message ?? error.keyword}`;
  }).join("\n");
}

function resolveConfigPaths(sourcePath: string, config: CampaignConfig): void {
  const base = dirname(sourcePath);
  config.environment = resolve(base, config.environment);
  config.workspace.hostBaseCheckout = resolve(base, config.workspace.hostBaseCheckout);
  config.workspace.candidatesDirectory = resolve(base, config.workspace.candidatesDirectory);
  config.resources.journalPath = resolve(base, config.resources.journalPath);
  config.loop.restartRequestPath = resolve(base, config.loop.restartRequestPath);
  if (config.loop.pausePath) config.loop.pausePath = resolve(base, config.loop.pausePath);
  config.evaluator.model.path = resolve(base, config.evaluator.model.path);
  config.evaluator.model.metadata.hostPath = resolve(
    base,
    config.evaluator.model.metadata.hostPath,
  );
  config.evaluator.request.path = resolve(base, config.evaluator.request.path);
  for (const runner of config.evaluator.probeRunners) {
    runner.executable = resolve(base, runner.executable);
  }
}

export async function loadCampaign(path: string): Promise<ResolvedCampaign> {
  const sourcePath = resolve(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await Deno.readTextFile(sourcePath));
  } catch (error) {
    throw new Error(
      `Could not read campaign ${sourcePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const schema = JSON.parse(await Deno.readTextFile(CAMPAIGN_SCHEMA));
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  if (!validate(parsed)) {
    throw new Error(`Invalid campaign ${sourcePath}:\n${formatAjvErrors(validate.errors)}`);
  }
  const config = parsed as CampaignConfig;
  resolveConfigPaths(sourcePath, config);
  return { sourcePath, config, environment: await loadAgentEnvironment(config.environment) };
}

async function assertPath(path: string, label: string, executable = false): Promise<void> {
  const stat = await Deno.stat(path).catch(() => undefined);
  if (!stat) throw new Error(`${label} not found: ${path}`);
  if (executable && ((stat.mode ?? 0) & 0o111) === 0) {
    throw new Error(`${label} is not executable: ${path}`);
  }
}

async function commandOutput(
  argv: string[],
  options: { cwd?: string; env?: Record<string, string>; inherit?: boolean } = {},
): Promise<Deno.CommandOutput> {
  const [command, ...args] = argv;
  const inherit = options.inherit ?? false;
  const output = await new Deno.Command(command, {
    args,
    cwd: options.cwd,
    env: options.env,
    stdin: inherit ? "inherit" : "null",
    stdout: inherit ? "inherit" : "piped",
    stderr: inherit ? "inherit" : "piped",
  }).output();
  return output;
}

async function gitText(checkout: string, args: string[]): Promise<string> {
  const output = await commandOutput(["/usr/bin/git", "-C", checkout, ...args]);
  if (!output.success) {
    throw new Error(new TextDecoder().decode(output.stderr).trim() || `git ${args[0]} failed`);
  }
  return new TextDecoder().decode(output.stdout).trim();
}

async function sha256(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function candidateHash(checkout: string): Promise<string> {
  const head = await gitText(checkout, ["rev-parse", "HEAD"]);
  const diff = await commandOutput(["/usr/bin/git", "-C", checkout, "diff", "--binary", "HEAD"]);
  if (!diff.success) throw new Error("Could not capture candidate diff");
  const untrackedOutput = await commandOutput([
    "/usr/bin/git",
    "-C",
    checkout,
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  if (!untrackedOutput.success) throw new Error("Could not enumerate candidate untracked files");
  const untracked = new TextDecoder().decode(untrackedOutput.stdout).split("\0").filter(Boolean)
    .sort();
  const chunks: Uint8Array[] = [new TextEncoder().encode(`${head}\0`), diff.stdout];
  for (const path of untracked) {
    chunks.push(new TextEncoder().encode(`\0${path}\0`));
    chunks.push(await Deno.readFile(join(checkout, path)));
  }
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const all = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.length;
  }
  return await sha256(all);
}

async function validateCampaign(campaign: ResolvedCampaign): Promise<void> {
  const { config, environment } = campaign;
  const requiredTransport = config.harness.kind === "codex-app-server" ? "app-server" : "pi-rpc";
  if (environment.config.worker?.transport !== requiredTransport) {
    throw new Error(
      `${config.harness.kind} campaigns require a ${requiredTransport} environment worker`,
    );
  }
  if (environment.config.guest.workspace !== config.workspace.guestCheckout) {
    throw new Error("Campaign guestCheckout must equal the environment guest workspace");
  }
  await assertPath(config.workspace.hostBaseCheckout, "Host base checkout");
  await gitText(config.workspace.hostBaseCheckout, ["rev-parse", "HEAD"]);
  await assertPath(config.evaluator.python, "Evaluator Python", true);
  await assertPath(config.evaluator.model.path, "Evaluator model");
  await assertPath(config.evaluator.model.metadata.command.argv[0], "Metadata extractor", true);
  await assertPath(config.evaluator.request.path, "Benchmark request");
  const model = await Deno.stat(config.evaluator.model.path);
  if (model.size !== config.evaluator.model.size) {
    throw new Error(
      `Evaluator model size is ${model.size}, expected ${config.evaluator.model.size}`,
    );
  }
  await assertPath(`${config.resources.vram.devicePath}/mem_info_vram_used`, "VRAM counter");
  const names = config.evaluator.tiers.map((tier) => tier.name);
  if (new Set(names).size !== names.length) throw new Error("Evaluator tier names must be unique");
  const probeNames = config.evaluator.probeRunners.map((runner) => runner.name);
  if (new Set(probeNames).size !== probeNames.length) {
    throw new Error("Evaluator probe-runner names must be unique");
  }
  for (const runner of config.evaluator.probeRunners) {
    await assertPath(runner.executable, `Probe runner ${runner.name}`, true);
    for (const prefix of runner.allowedPathPrefixes) {
      if (
        isAbsolute(prefix) || normalize(prefix) !== prefix || prefix.startsWith("../") ||
        !prefix.endsWith("/")
      ) {
        throw new Error(`Probe runner ${runner.name} has an unsafe path prefix: ${prefix}`);
      }
    }
  }
  if (config.resources.ports.includes(config.evaluator.listenPort) === false) {
    throw new Error("Evaluator listenPort must be included in protected resource ports");
  }
}

function printCampaignPlan(campaign: ResolvedCampaign): void {
  const { config } = campaign;
  console.log(`Campaign:       ${config.name}`);
  console.log(`Environment:    ${config.environment}`);
  console.log(`Harness:        ${config.harness.kind}`);
  console.log(`Worker checkout:${config.workspace.guestCheckout}`);
  console.log(`Base checkout:  ${config.workspace.hostBaseCheckout}`);
  console.log(`Worker services:${config.resources.workerServices.join(", ")}`);
  console.log(`GPU device:     ${config.resources.vram.devicePath}`);
  console.log(`Evaluator:      ${config.evaluator.device}, JIT=${config.evaluator.jit}`);
  console.log(`Model metadata: ${config.evaluator.model.metadata.guestPath}`);
  console.log(
    `Probe runners:  ${config.evaluator.probeRunners.map((runner) => runner.name).join(", ")}`,
  );
  for (const tier of config.evaluator.tiers) {
    console.log(
      `Tier ${tier.name}: ${tier.expectedPromptTokens}+${tier.maxOutputTokens}, ` +
        `${tier.repeats} run(s), parent ${tier.candidateBaselineWallMs.toFixed(2)} ms, ` +
        `competitor ${tier.competitorWallMs.toFixed(2)} ms`,
    );
  }
}

export function campaignUsage(): string {
  return `Usage: lm campaign [CONFIG] ACTION [options]

Manage a benchmark-gated autonomous optimization campaign. CONFIG defaults to:
  ${DEFAULT_CAMPAIGN}

Actions:
  --check              Validate declarations and protected host artifacts
  --dry-run            Print the resolved worker/evaluator plan
  --status             Print the durable campaign journal
  --evaluate-current   Export and evaluate the current guest candidate without a worker turn
  --cycle-once         Run one finite worker turn, evaluate, restore services, and record the result
  --loop               Continuously run complete worker/evaluator cycles
  --pause              Stop GPU services and persist paused state across shutdown/reboot
  --resume             Restore services and continue in a fresh discovery phase
  --restart-phase NAME Force the continuous controller to restart at worker phase NAME
  --notify MESSAGE     Deliver a durable live update to the active worker turn
  --sync-model-metadata Regenerate if stale and mirror model metadata into the worker

Options:
  --tier NAME          Stop after this evaluator tier (only with --evaluate-current)
  --start-phase NAME   Resume --cycle-once at a named worker phase
  --help               Show this help`;
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await Deno.mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${Deno.pid}`;
  await Deno.writeTextFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await Deno.rename(temporary, path);
}

async function readJournal(campaign: ResolvedCampaign): Promise<CampaignJournal> {
  const path = campaign.config.resources.journalPath;
  try {
    return JSON.parse(await Deno.readTextFile(path)) as CampaignJournal;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  const base = campaign.config.workspace.hostBaseCheckout;
  return {
    version: 1,
    campaign: campaign.config.name,
    phase: "WORKER_READY",
    updatedAt: new Date().toISOString(),
    cycle: 0,
    accepted: {
      path: base,
      hash: await candidateHash(base),
      metrics: Object.fromEntries(
        campaign.config.evaluator.tiers.map((tier) => [tier.name, tier.candidateBaselineWallMs]),
      ),
    },
  };
}

async function writePhase(
  campaign: ResolvedCampaign,
  journal: CampaignJournal,
  phase: Phase,
  extra: Partial<CampaignJournal> = {},
): Promise<CampaignJournal> {
  const next = { ...journal, ...extra, phase, updatedAt: new Date().toISOString() };
  await writeJsonAtomic(campaign.config.resources.journalPath, next);
  return next;
}

async function acquireCampaignLock(path: string): Promise<() => Promise<void>> {
  await Deno.mkdir(dirname(path), { recursive: true });
  try {
    const file = await Deno.open(path, { write: true, createNew: true });
    await file.write(new TextEncoder().encode(`${Deno.pid}\n`));
    file.close();
  } catch (error) {
    if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
    const owner = Number((await Deno.readTextFile(path).catch(() => "0")).trim());
    if (owner > 0) {
      const alive = await Deno.stat(`/proc/${owner}`).then(() => true).catch(() => false);
      if (alive) throw new Error(`Campaign is already controlled by process ${owner}`);
    }
    await Deno.remove(path).catch(() => undefined);
    return await acquireCampaignLock(path);
  }
  return async () => {
    const owner = await Deno.readTextFile(path).catch(() => "");
    if (owner.trim() === String(Deno.pid)) await Deno.remove(path).catch(() => undefined);
  };
}

async function systemctl(args: string[], inherit = false): Promise<Deno.CommandOutput> {
  const output = await commandOutput(["/usr/bin/systemctl", "--user", ...args], { inherit });
  if (!output.success) {
    const stderr = new TextDecoder().decode(output.stderr).trim();
    throw new Error(`systemctl --user ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`);
  }
  return output;
}

async function waitUntil(
  description: string,
  timeoutSeconds: number,
  predicate: () => Promise<boolean>,
): Promise<void> {
  const deadline = performance.now() + timeoutSeconds * 1000;
  while (performance.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function portOpen(port: number): Promise<boolean> {
  try {
    const connection = await Deno.connect({ hostname: "127.0.0.1", port });
    connection.close();
    return true;
  } catch {
    return false;
  }
}

async function vramMiB(devicePath: string): Promise<number> {
  const bytes = Number(await Deno.readTextFile(`${devicePath}/mem_info_vram_used`));
  return Math.round(bytes / 1048576);
}

async function startWorkerServices(campaign: ResolvedCampaign): Promise<void> {
  const { resources } = campaign.config;
  await systemctl(["start", ...resources.workerServices]);
  await waitUntil("worker services", resources.shutdownTimeoutSeconds * 3, async () => {
    for (const service of resources.workerServices) {
      const active = await commandOutput([
        "/usr/bin/systemctl",
        "--user",
        "is-active",
        "--quiet",
        service,
      ]);
      if (!active.success) return false;
    }
    for (const url of resources.workerReadyUrls) {
      const ready = await fetch(url, { signal: AbortSignal.timeout(1000) }).then((response) =>
        response.ok
      ).catch(() => false);
      if (!ready) return false;
    }
    return true;
  });
}

async function stopWorkerServices(campaign: ResolvedCampaign): Promise<void> {
  const { resources } = campaign.config;
  await systemctl(["stop", ...[...resources.workerServices].reverse()]);
  await waitUntil("worker services to stop", resources.shutdownTimeoutSeconds, async () => {
    for (const service of resources.workerServices) {
      const active = await commandOutput([
        "/usr/bin/systemctl",
        "--user",
        "is-active",
        "--quiet",
        service,
      ]);
      if (active.success) return false;
    }
    return true;
  });
}

async function waitForGpuQuiescence(campaign: ResolvedCampaign): Promise<void> {
  const { resources } = campaign.config;
  await waitUntil("GPU quiescence", resources.shutdownTimeoutSeconds, async () => {
    if ((await vramMiB(resources.vram.devicePath)) > resources.vram.quiescentMaxMiB) return false;
    for (const port of resources.ports) if (await portOpen(port)) return false;
    return true;
  });
}

async function pipeCommands(
  producer: Deno.ChildProcess,
  consumer: Deno.ChildProcess,
  description: string,
): Promise<void> {
  const pipe = producer.stdout.pipeTo(consumer.stdin);
  const [producerStatus, consumerStatus] = await Promise.all([
    producer.status,
    consumer.status,
    pipe,
  ]);
  if (!producerStatus.success || !consumerStatus.success) {
    throw new Error(
      `${description} failed (${producerStatus.code}/${consumerStatus.code})`,
    );
  }
}

async function exportGuestCandidate(
  campaign: ResolvedCampaign,
  id: string,
): Promise<{ id: string; path: string; hash: string }> {
  const { backend, guest } = campaign.environment.config;
  const source = campaign.config.workspace.guestCheckout;
  const candidateRoot = join(campaign.config.workspace.candidatesDirectory, id);
  await Deno.mkdir(campaign.config.workspace.candidatesDirectory, { recursive: true });
  await Deno.mkdir(candidateRoot, { recursive: false });
  const archive = new Deno.Command(backend.executable, {
    args: [
      "exec",
      "-T",
      "--user",
      String(guest.uid),
      "--group",
      String(guest.gid),
      backend.instance,
      "--",
      "tar",
      "-C",
      dirname(source),
      "-cpf",
      "-",
      basename(source),
    ],
    stdin: "null",
    stdout: "piped",
    stderr: "inherit",
  }).spawn();
  const extract = new Deno.Command("/usr/bin/tar", {
    args: ["-xpf", "-", "-C", candidateRoot],
    stdin: "piped",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  await pipeCommands(archive, extract, "Candidate export");
  const checkout = join(candidateRoot, basename(source));
  const expectedHead = await gitText(campaign.config.workspace.hostBaseCheckout, [
    "rev-parse",
    "HEAD",
  ]);
  const actualHead = await gitText(checkout, ["rev-parse", "HEAD"]);
  if (actualHead !== expectedHead) {
    throw new Error(`Candidate changed Git HEAD: ${actualHead}, expected ${expectedHead}`);
  }
  return { id, path: checkout, hash: await candidateHash(checkout) };
}

async function restoreGuestCheckout(
  campaign: ResolvedCampaign,
  acceptedPath: string,
): Promise<void> {
  const { backend, guest } = campaign.environment.config;
  const target = campaign.config.workspace.guestCheckout;
  if (!target.startsWith(`${guest.home}/`) || target === guest.home) {
    throw new Error(`Refusing unsafe guest checkout replacement: ${target}`);
  }
  const remove = await commandOutput([
    backend.executable,
    "exec",
    "-T",
    "--user",
    String(guest.uid),
    "--group",
    String(guest.gid),
    backend.instance,
    "--",
    "rm",
    "-rf",
    target,
  ]);
  if (!remove.success) throw new Error("Could not remove rejected guest candidate");
  const archive = new Deno.Command("/usr/bin/tar", {
    args: ["-C", dirname(acceptedPath), "-cpf", "-", basename(acceptedPath)],
    stdin: "null",
    stdout: "piped",
    stderr: "inherit",
  }).spawn();
  const extract = new Deno.Command(backend.executable, {
    args: [
      "exec",
      "-T",
      "--user",
      String(guest.uid),
      "--group",
      String(guest.gid),
      backend.instance,
      "--",
      "tar",
      "-xpf",
      "-",
      "-C",
      dirname(target),
    ],
    stdin: "piped",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  await pipeCommands(archive, extract, "Accepted-candidate restore");
}

async function readEvaluationRequest(
  campaign: ResolvedCampaign,
): Promise<EvaluationRequest | undefined> {
  const { backend, guest } = campaign.environment.config;
  const output = await commandOutput([
    backend.executable,
    "exec",
    "-T",
    "--user",
    String(guest.uid),
    "--group",
    String(guest.gid),
    backend.instance,
    "--",
    "cat",
    campaign.config.workspace.guestEvaluationRequest,
  ]);
  if (!output.success) return undefined;
  return validateEvaluationRequest(
    JSON.parse(new TextDecoder().decode(output.stdout)),
    campaign,
  );
}

export function validateEvaluationRequest(
  value: unknown,
  campaign: ResolvedCampaign,
): EvaluationRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("EVAL_REQUEST.json must be an object");
  }
  const parsed = value as Record<string, unknown>;
  if (parsed.version !== 1 || !["benchmark", "profile", "probe"].includes(String(parsed.kind))) {
    throw new Error("Invalid EVAL_REQUEST.json version or kind");
  }
  const kind = parsed.kind as EvaluationRequest["kind"];
  const allowedKeys = new Set(["version", "kind", "focus", "environment"]);
  if (kind === "probe") allowedKeys.add("probe");
  else allowedKeys.add("tier");
  for (const key of Object.keys(parsed)) {
    if (!allowedKeys.has(key)) throw new Error(`Unknown EVAL_REQUEST.json field: ${key}`);
  }
  if (
    parsed.tier !== undefined &&
    (typeof parsed.tier !== "string" ||
      !campaign.config.evaluator.tiers.some((tier) => tier.name === parsed.tier))
  ) {
    throw new Error(`Unknown requested evaluator tier: ${String(parsed.tier)}`);
  }
  if (parsed.focus !== undefined && typeof parsed.focus !== "string") {
    throw new Error("Evaluator focus must be a string");
  }
  if (
    parsed.environment !== undefined &&
    (!parsed.environment || typeof parsed.environment !== "object" ||
      Array.isArray(parsed.environment))
  ) {
    throw new Error("Evaluator environment must be an object");
  }
  const allowed = new Set(campaign.config.evaluator.allowedRequestEnvironment);
  for (
    const [name, setting] of Object.entries(parsed.environment as Record<string, unknown> ?? {})
  ) {
    if (!allowed.has(name)) {
      throw new Error(`Evaluator environment variable is not allowed: ${name}`);
    }
    if (typeof setting !== "string") {
      throw new Error(`Evaluator environment variable ${name} must be a string`);
    }
  }
  if (kind === "probe") {
    if (!parsed.probe || typeof parsed.probe !== "object" || Array.isArray(parsed.probe)) {
      throw new Error("Probe request must declare probe.runner and probe.path");
    }
    const probe = parsed.probe as Record<string, unknown>;
    for (const key of Object.keys(probe)) {
      if (!new Set(["runner", "path"]).has(key)) throw new Error(`Unknown probe field: ${key}`);
    }
    if (
      typeof probe.runner !== "string" ||
      !campaign.config.evaluator.probeRunners.some((runner) => runner.name === probe.runner)
    ) {
      throw new Error(`Unknown probe runner: ${String(probe.runner)}`);
    }
    if (
      typeof probe.path !== "string" || !probe.path || isAbsolute(probe.path) ||
      normalize(probe.path) !== probe.path || probe.path.startsWith("../") ||
      probe.path.includes("\0")
    ) {
      throw new Error(
        `Probe path must be a normalized candidate-relative path: ${String(probe.path)}`,
      );
    }
    const probePath = probe.path as string;
    const runner = campaign.config.evaluator.probeRunners.find((item) =>
      item.name === probe.runner
    )!;
    if (!runner.allowedPathPrefixes.some((prefix) => probePath.startsWith(prefix))) {
      throw new Error(`Probe path is outside runner ${runner.name}'s allowed prefixes`);
    }
  } else if (parsed.probe !== undefined) {
    throw new Error(`Evaluation kind ${kind} cannot declare a probe`);
  }
  return parsed as unknown as EvaluationRequest;
}

function interpolateCandidate(value: string, candidate: string): string {
  return value.replaceAll("${candidate}", candidate);
}

async function runUnitCommands(
  campaign: ResolvedCampaign,
  candidate: { id: string; path: string; hash: string },
  resultDirectory: string,
): Promise<Array<{ argv: string[]; exitCode: number; log: string }>> {
  const results = [];
  for (let index = 0; index < campaign.config.evaluator.unitCommands.length; index++) {
    const command = campaign.config.evaluator.unitCommands[index];
    const argv = command.argv.map((value) => interpolateCandidate(value, candidate.path));
    const environment = Object.fromEntries(
      Object.entries(command.environment).map(([name, value]) => [
        name,
        interpolateCandidate(value, candidate.path),
      ]),
    );
    const output = await commandOutput(argv, { cwd: candidate.path, env: environment });
    const log = join(resultDirectory, `unit-${index}.log`);
    await Deno.writeTextFile(
      log,
      new TextDecoder().decode(output.stdout) + new TextDecoder().decode(output.stderr),
    );
    results.push({ argv, exitCode: output.code, log });
    if (!output.success) throw new Error(`Unit command failed (${output.code}): ${argv.join(" ")}`);
  }
  return results;
}

async function drainStream(stream: ReadableStream<Uint8Array>, path: string): Promise<void> {
  const file = await Deno.open(path, { createNew: true, write: true });
  try {
    for await (const chunk of stream) await file.write(chunk);
  } finally {
    file.close();
  }
}

async function runProbe(
  campaign: ResolvedCampaign,
  candidate: { id: string; path: string; hash: string },
  request: EvaluationRequest,
  resultDirectory: string,
): Promise<ProbeResult> {
  const declaration = request.probe!;
  const runner = campaign.config.evaluator.probeRunners.find((item) =>
    item.name === declaration.runner
  )!;
  const candidateRoot = await Deno.realPath(candidate.path);
  const requestedPath = resolve(candidateRoot, declaration.path);
  const target = await Deno.realPath(requestedPath).catch(() => undefined);
  if (!target || !(target === candidateRoot || target.startsWith(`${candidateRoot}/`))) {
    throw new Error(`Probe target escapes or is absent from candidate: ${declaration.path}`);
  }
  const targetStat = await Deno.stat(target);
  if (!targetStat.isFile) {
    throw new Error(`Probe target is not a regular file: ${declaration.path}`);
  }

  const stdoutLog = join(resultDirectory, "probe.stdout.log");
  const stderrLog = join(resultDirectory, "probe.stderr.log");
  const argv = [runner.executable, target];
  const environment = {
    DEV: campaign.config.evaluator.device,
    JIT: String(campaign.config.evaluator.jit),
    PYTHONPATH: candidateRoot,
    ...Object.fromEntries(
      Object.entries(runner.environment).map(([name, setting]) => [
        name,
        interpolateCandidate(setting, candidateRoot),
      ]),
    ),
    ...(request.environment ?? {}),
  };
  const started = performance.now();
  const child = new Deno.Command("/usr/bin/setsid", {
    args: [
      "/usr/bin/timeout",
      "--signal=TERM",
      "--kill-after=5s",
      String(runner.timeoutSeconds),
      ...argv,
    ],
    cwd: candidateRoot,
    env: environment,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const stdoutDrain = drainStream(child.stdout, stdoutLog);
  const stderrDrain = drainStream(child.stderr, stderrLog);
  const status = await child.status;
  await Promise.all([stdoutDrain, stderrDrain]);
  const wallMs = performance.now() - started;
  const stdout = await Deno.readTextFile(stdoutLog);
  const profile = summarizeTinygradProfile(stdout, stdoutLog);
  return {
    runner: runner.name,
    path: declaration.path,
    argv,
    exitCode: status.code,
    timedOut: status.code === 124,
    wallMs,
    stdoutLog,
    stderrLog,
    profile: profile.kernelCount > 0 ? profile : undefined,
    executionSucceeded: status.success,
  };
}

export function median(values: number[]): number {
  if (values.length === 0) throw new Error("Cannot take median of an empty list");
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function tinygradKernelFamily(name: string): string {
  if (name.startsWith("batched ")) return "captured_graph";
  if (name.startsWith("gated_delta_prefill")) return "gated_delta_prefill";
  if (name.startsWith("q8_quantize")) return "q8_quantize";
  if (name.startsWith("flash_")) return "flash_attention";
  if (name.startsWith("copy")) return "copy";
  if (name === "E" || name.startsWith("E_")) return "generated_elementwise";
  if (name === "r" || name.startsWith("r_")) return "generated_reduction";
  return name.split(/\s+/, 1)[0];
}

export function summarizeTinygradProfile(text: string, sourceLog: string): TinygradProfileSummary {
  const marker = "*** started server";
  const hasMarker = text.includes(marker);
  let afterStart = !hasMarker;
  const exact = new Map<string, { count: number; totalMs: number }>();
  const families = new Map<string, { count: number; totalMs: number }>();
  const expression = /^\*\*\* AMD\s+\d+\s+(.+?)\s+arg\s+\d+.*?\btm\s+([0-9.]+)(us|ms)\//;
  for (const line of text.split("\n")) {
    if (line.includes(marker)) {
      afterStart = true;
      continue;
    }
    if (!afterStart) continue;
    const match = expression.exec(line);
    if (!match) continue;
    const name = match[1].trim();
    const milliseconds = Number(match[2]) * (match[3] === "us" ? 0.001 : 1);
    const exactEntry = exact.get(name) ?? { count: 0, totalMs: 0 };
    exactEntry.count += 1;
    exactEntry.totalMs += milliseconds;
    exact.set(name, exactEntry);
    const family = tinygradKernelFamily(name);
    const familyEntry = families.get(family) ?? { count: 0, totalMs: 0 };
    familyEntry.count += 1;
    familyEntry.totalMs += milliseconds;
    families.set(family, familyEntry);
  }
  const kernelTimeMs = [...exact.values()].reduce((sum, entry) => sum + entry.totalMs, 0);
  const entries = (values: Map<string, { count: number; totalMs: number }>) =>
    [...values.entries()].map(([name, entry]): KernelProfileEntry => ({
      name,
      count: entry.count,
      totalMs: Number(entry.totalMs.toFixed(3)),
      averageMs: Number((entry.totalMs / entry.count).toFixed(6)),
      percentKernelTime: kernelTimeMs === 0
        ? 0
        : Number((entry.totalMs / kernelTimeMs * 100).toFixed(3)),
    })).sort((left, right) => right.totalMs - left.totalMs);
  return {
    sourceLog,
    scope: hasMarker ? "after-server-start" : "whole-log",
    opaqueGraphReplay: [...exact.keys()].some((name) => name.startsWith("batched ")),
    kernelCount: [...exact.values()].reduce((sum, entry) => sum + entry.count, 0),
    kernelTimeMs: Number(kernelTimeMs.toFixed(3)),
    families: entries(families),
    topKernels: entries(exact).slice(0, 32),
  };
}

function responseUsage(response: unknown): { promptTokens: number; completionTokens: number } {
  if (!response || typeof response !== "object") return { promptTokens: 0, completionTokens: 0 };
  const body = response as Record<string, unknown>;
  const usage = body.usage && typeof body.usage === "object"
    ? body.usage as Record<string, unknown>
    : {};
  return {
    promptTokens: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0,
    completionTokens: typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0,
  };
}

function responseAssistantText(response: unknown): string {
  if (!response || typeof response !== "object") return "";
  const choices = (response as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== "object") return "";
  const message = (choices[0] as Record<string, unknown>).message;
  if (!message || typeof message !== "object") return "";
  const value = message as Record<string, unknown>;
  return (typeof value.reasoning_content === "string" ? value.reasoning_content : "") +
    (typeof value.content === "string" ? value.content : "");
}

async function runBenchmarkTier(
  campaign: ResolvedCampaign,
  tier: TierConfig,
  resultDirectory: string,
  runIndex: number,
): Promise<TierRun> {
  const resultPath = join(resultDirectory, `${tier.name}-${runIndex + 1}.json`);
  const evaluator = campaign.config.evaluator;
  const args = [
    "run",
    "-A",
    `${PROJECT_ROOT}/main.ts`,
    "benchmark",
    evaluator.request.path,
    "--api",
    evaluator.request.api,
    "--url",
    `http://127.0.0.1:${evaluator.listenPort}/v1/chat/completions`,
    "--max-output-tokens",
    String(tier.maxOutputTokens),
    "--expect-prompt-tokens",
    String(tier.expectedPromptTokens),
    "--vram-device",
    campaign.config.resources.vram.devicePath,
    "--output",
    resultPath,
  ];
  if (tier.maxInputChars !== undefined) {
    args.push("--max-input-chars", String(tier.maxInputChars));
  }
  const output = await commandOutput([Deno.execPath(), ...args]);
  if (!output.success) {
    throw new Error(
      new TextDecoder().decode(output.stderr).trim() || `Benchmark tier ${tier.name} failed`,
    );
  }
  const raw = JSON.parse(await Deno.readTextFile(resultPath)) as Record<string, unknown>;
  const response = raw.response;
  const usage = responseUsage(response);
  const peakVramMiB = raw.vram && typeof raw.vram === "object" &&
      typeof (raw.vram as Record<string, unknown>).peakMiB === "number"
    ? (raw.vram as Record<string, number>).peakMiB
    : undefined;
  const outputSha256 = await sha256(responseAssistantText(response));
  const failures: string[] = [];
  if (usage.promptTokens !== tier.expectedPromptTokens) {
    failures.push(`prompt tokens ${usage.promptTokens} != ${tier.expectedPromptTokens}`);
  }
  if (usage.completionTokens !== tier.maxOutputTokens) {
    failures.push(`completion tokens ${usage.completionTokens} != ${tier.maxOutputTokens}`);
  }
  if (outputSha256 !== tier.expectedOutputSha256) failures.push("assistant output hash changed");
  if (
    peakVramMiB === undefined ||
    peakVramMiB > campaign.config.resources.vram.peakMaxMiB
  ) {
    failures.push(
      `peak VRAM ${String(peakVramMiB)} exceeds ${campaign.config.resources.vram.peakMaxMiB} MiB`,
    );
  }
  return {
    resultPath,
    wallMs: typeof raw.wallMs === "number" ? raw.wallMs : Number.POSITIVE_INFINITY,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    peakVramMiB,
    outputSha256,
    passed: failures.length === 0,
    failures,
  };
}

async function evaluateCandidate(
  campaign: ResolvedCampaign,
  journal: CampaignJournal,
  candidate: { id: string; path: string; hash: string },
  requestedStopTier?: string,
): Promise<{ result: EvaluationResult; resultPath: string }> {
  const evaluator = campaign.config.evaluator;
  const resultDirectory = join(
    campaign.config.workspace.candidatesDirectory,
    candidate.id,
    "results",
  );
  await Deno.mkdir(resultDirectory, { recursive: true });
  const startedAt = new Date().toISOString();
  const request = await readEvaluationRequest(campaign);
  const result: EvaluationResult = {
    version: 1,
    campaign: campaign.config.name,
    candidate,
    startedAt,
    finishedAt: startedAt,
    request,
    unitCommands: [],
    tiers: [],
    accepted: false,
  };
  const resultPath = join(resultDirectory, "evaluation.json");
  const stdoutLog = join(resultDirectory, "server.stdout.log");
  const stderrLog = join(resultDirectory, "server.stderr.log");
  let server: Deno.ChildProcess | undefined;
  let stdoutDrain: Promise<void> | undefined;
  let stderrDrain: Promise<void> | undefined;
  try {
    if (request?.kind === "probe") {
      result.probe = await runProbe(campaign, candidate, request, resultDirectory);
      if (!result.probe.executionSucceeded) {
        result.failure = result.probe.timedOut
          ? `Probe timed out after ${
            campaign.config.evaluator.probeRunners.find((runner) =>
              runner.name === request.probe!.runner
            )!.timeoutSeconds
          }s`
          : `Probe exited with status ${result.probe.exitCode}`;
      }
      return { result, resultPath };
    }
    result.unitCommands = await runUnitCommands(campaign, candidate, resultDirectory);
    const serverEnvironment = {
      DEV: evaluator.device,
      JIT: String(evaluator.jit),
      PYTHONPATH: candidate.path,
      PYTHONUNBUFFERED: "1",
      ...(request?.environment ?? {}),
    };
    server = new Deno.Command(evaluator.python, {
      args: [
        "-m",
        "tinygrad.llm",
        "--model",
        evaluator.model.path,
        "--max_context",
        String(evaluator.contextWindow),
        "--serve",
        String(evaluator.listenPort),
      ],
      cwd: candidate.path,
      env: serverEnvironment,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    stdoutDrain = drainStream(server.stdout, stdoutLog);
    stderrDrain = drainStream(server.stderr, stderrLog);
    await waitUntil("candidate server readiness", evaluator.startupTimeoutSeconds, async () => {
      const exited = await Promise.race([
        server!.status.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 0)),
      ]);
      if (exited) throw new Error("Candidate server exited before becoming ready");
      return await portOpen(evaluator.listenPort);
    });

    for (const tier of evaluator.tiers) {
      const runs = [];
      for (let index = 0; index < tier.repeats; index++) {
        const run = await runBenchmarkTier(campaign, tier, resultDirectory, index);
        runs.push(run);
        if (!run.passed) break;
      }
      const medianWallMs = median(runs.map((run) => run.wallMs));
      const parentWallMs = journal.accepted.metrics[tier.name] ?? tier.candidateBaselineWallMs;
      const improvementPercent = (1 - medianWallMs / parentWallMs) * 100;
      const passed = runs.length === tier.repeats && runs.every((run) => run.passed);
      const earnedNext = passed && tier.promoteBelowParentPercent !== undefined &&
        improvementPercent >= tier.promoteBelowParentPercent;
      result.tiers.push({
        name: tier.name,
        runs,
        medianWallMs,
        parentWallMs,
        competitorWallMs: tier.competitorWallMs,
        improvementPercent,
        passed,
        earnedNext,
      });
      if (requestedStopTier === tier.name) break;
      if (!passed || !earnedNext) break;
    }
    const allTiers = result.tiers.length === evaluator.tiers.length;
    const last = result.tiers.at(-1);
    result.accepted = requestedStopTier === undefined && allTiers && Boolean(last?.passed) &&
      (last?.medianWallMs ?? Infinity) < (last?.parentWallMs ?? 0);
  } catch (error) {
    result.failure = error instanceof Error ? error.message : String(error);
  } finally {
    if (server) await terminateChild(server, 5000);
    await Promise.all([stdoutDrain, stderrDrain].filter(Boolean) as Promise<void>[]);
    if (result.failure) {
      const stderr = await Deno.readTextFile(stderrLog).catch(() => "");
      result.failure = classifyEvaluatorFailure(result.failure, stderr);
    }
    if (request?.kind === "profile") {
      const profileText = await Deno.readTextFile(stdoutLog).catch(() => "");
      result.profile = summarizeTinygradProfile(profileText, stdoutLog);
    }
    result.finishedAt = new Date().toISOString();
    await writeJsonAtomic(resultPath, result);
  }
  return { result, resultPath };
}

async function serviceActive(service: string): Promise<boolean> {
  return (await commandOutput([
    "/usr/bin/systemctl",
    "--user",
    "is-active",
    "--quiet",
    service,
  ])).success;
}

async function terminateEvaluatorListener(campaign: ResolvedCampaign): Promise<void> {
  const port = campaign.config.evaluator.listenPort;
  const output = await commandOutput([
    "/usr/bin/ss",
    "-H",
    "-ltnp",
    `sport = :${port}`,
  ]);
  if (!output.success) return;
  const text = new TextDecoder().decode(output.stdout);
  const pids = [...text.matchAll(/pid=(\d+)/g)].map((match) => Number(match[1]));
  for (const pid of new Set(pids)) await terminatePid(pid, 5000);
}

async function pushEvaluationResult(campaign: ResolvedCampaign, resultPath: string): Promise<void> {
  const { backend, guest } = campaign.environment.config;
  const target = campaign.config.workspace.guestEvaluationResult;
  const resultDirectory = dirname(resultPath);
  const candidateId = basename(dirname(resultDirectory));
  const guestResultDirectory = join(
    campaign.config.workspace.guestEvaluationArtifactsDirectory,
    candidateId,
    "results",
  );
  const mkdir = await commandOutput([
    backend.executable,
    "exec",
    backend.instance,
    "--",
    "mkdir",
    "-p",
    dirname(target),
    guestResultDirectory,
  ]);
  if (!mkdir.success) throw new Error("Could not create guest evaluation-result directory");
  for await (const entry of Deno.readDir(resultDirectory)) {
    if (!entry.isFile) continue;
    const artifactPush = await commandOutput([
      backend.executable,
      "file",
      "push",
      join(resultDirectory, entry.name),
      `${backend.instance}${join(guestResultDirectory, entry.name)}`,
    ]);
    if (!artifactPush.success) throw new Error(`Could not copy evaluator artifact ${entry.name}`);
  }
  const push = await commandOutput([
    backend.executable,
    "file",
    "push",
    resultPath,
    `${backend.instance}${target}`,
  ]);
  if (!push.success) throw new Error("Could not copy evaluation result into guest");
  const own = await commandOutput([
    backend.executable,
    "exec",
    backend.instance,
    "--",
    "chown",
    "-R",
    `${guest.uid}:${guest.gid}`,
    target,
    guestResultDirectory,
  ]);
  if (!own.success) throw new Error("Could not set guest evaluation-result ownership");
  await commandOutput([
    backend.executable,
    "exec",
    backend.instance,
    "--",
    "rm",
    "-f",
    campaign.config.workspace.guestEvaluationRequest,
  ]);
}

async function ensureEnvironmentRunning(campaign: ResolvedCampaign): Promise<void> {
  const { backend } = campaign.environment.config;
  const running = await commandOutput([
    backend.executable,
    "exec",
    backend.instance,
    "--",
    "true",
  ]);
  if (!running.success) {
    throw new Error(
      `Incus environment ${backend.instance} is not running; apply it with lm env first`,
    );
  }
}

async function evaluateExportedCandidate(
  campaign: ResolvedCampaign,
  journal: CampaignJournal,
  candidate: { id: string; path: string; hash: string },
  stopTier?: string,
  restoreRejected = true,
): Promise<{ journal: CampaignJournal; evaluation: EvaluationResult; resultPath: string }> {
  journal = await writePhase(campaign, journal, "VULKAN_STOPPING", {
    activeCandidate: candidate,
    lastError: undefined,
  });
  await stopWorkerServices(campaign);
  await terminateEvaluatorListener(campaign);
  await waitForGpuQuiescence(campaign);
  journal = await writePhase(campaign, journal, "GPU_QUIESCENT");
  journal = await writePhase(campaign, journal, "EVALUATING");
  const evaluated = await evaluateCandidate(campaign, journal, candidate, stopTier);
  const metrics = Object.fromEntries(
    evaluated.result.tiers.map((tier) => [tier.name, tier.medianWallMs]),
  );
  if (evaluated.result.accepted) {
    journal.accepted = { path: candidate.path, hash: candidate.hash, metrics };
  } else if (restoreRejected && evaluated.result.request?.kind !== "probe") {
    await restoreGuestCheckout(campaign, journal.accepted.path);
  }
  journal = await writePhase(campaign, journal, "RESULT_RECORDED", {
    accepted: journal.accepted,
    lastResult: evaluated.resultPath,
    lastError: evaluated.result.failure,
  });
  await pushEvaluationResult(campaign, evaluated.resultPath);
  return { journal, evaluation: evaluated.result, resultPath: evaluated.resultPath };
}

async function reconcileForWorker(campaign: ResolvedCampaign, journal: CampaignJournal) {
  await terminateEvaluatorListener(campaign);
  if (await portOpen(campaign.config.evaluator.listenPort)) {
    throw new Error(`Evaluator port ${campaign.config.evaluator.listenPort} remains occupied`);
  }
  journal = await writePhase(campaign, journal, "VULKAN_STARTING");
  await startWorkerServices(campaign);
  return await writePhase(campaign, journal, "WORKER_READY", {
    activeCandidate: undefined,
  });
}

async function runCycleOnce(
  campaign: ResolvedCampaign,
  startPhase?: string,
): Promise<EvaluationResult> {
  const release = await acquireCampaignLock(campaign.config.resources.lockPath);
  let journal = await readJournal(campaign);
  let servicesStarted = false;
  try {
    await ensureEnvironmentRunning(campaign);
    await syncModelMetadata(campaign);
    journal = await reconcileForWorker(campaign, journal);
    servicesStarted = true;
    journal = await writePhase(campaign, journal, "WORKER_RUNNING", {
      cycle: journal.cycle + 1,
      lastError: undefined,
    });
    const worker = await runWorkerOnce(campaign.environment, { startPhase });
    if (worker.run.exitCode !== 0) {
      throw new Error(`Worker turn exited with status ${worker.run.exitCode}`);
    }
    const id = `cycle-${String(journal.cycle).padStart(5, "0")}-${Date.now()}`;
    const candidate = await exportGuestCandidate(campaign, id);
    journal = await writePhase(campaign, journal, "CANDIDATE_EXPORTED", {
      activeCandidate: candidate,
    });
    servicesStarted = false;
    const evaluated = await evaluateExportedCandidate(campaign, journal, candidate);
    journal = evaluated.journal;
    servicesStarted = false;
    journal = await reconcileForWorker(campaign, journal);
    servicesStarted = true;
    return evaluated.evaluation;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writePhase(campaign, journal, journal.phase, { lastError: message }).catch(() =>
      undefined
    );
    throw error;
  } finally {
    if (!servicesStarted) {
      await reconcileForWorker(campaign, journal).catch((error) =>
        console.error(`Could not restore worker services: ${error}`)
      );
    }
    await release();
  }
}

async function runCampaignLoop(campaign: ResolvedCampaign): Promise<void> {
  const initial = await readJournal(campaign);
  const pauseMarker = campaign.config.loop.pausePath &&
    await Deno.stat(campaign.config.loop.pausePath).then(() => true).catch(() => false);
  if (initial.phase === "PAUSED" || pauseMarker) {
    await terminateEvaluatorListener(campaign);
    await stopWorkerServices(campaign);
    console.log("Campaign is paused; use --resume to continue");
    return;
  }
  let stopping = false;
  const requestStop = () => {
    stopping = true;
    console.log("Campaign loop will stop after the current cycle");
  };
  Deno.addSignalListener("SIGINT", requestStop);
  Deno.addSignalListener("SIGTERM", requestStop);
  try {
    while (!stopping) {
      let cooldown = campaign.config.loop.successCooldownSeconds;
      try {
        const restart = await readRestartRequest(campaign);
        if (restart) console.log(`Restarting campaign at phase ${restart.phase}`);
        console.log(evaluationSummary(await runCycleOnce(campaign, restart?.phase)));
      } catch (error) {
        cooldown = campaign.config.loop.failureCooldownSeconds;
        console.error(`Campaign cycle failed: ${error instanceof Error ? error.message : error}`);
      }
      if (stopping) break;
      console.log(`Next campaign cycle in ${cooldown}s`);
      await new Promise((resolve) => setTimeout(resolve, cooldown * 1000));
    }
  } finally {
    Deno.removeSignalListener("SIGINT", requestStop);
    Deno.removeSignalListener("SIGTERM", requestStop);
  }
}

interface RestartRequest {
  version: 1;
  phase: string;
  requestedAt: string;
}

async function readRestartRequest(campaign: ResolvedCampaign): Promise<RestartRequest | undefined> {
  try {
    const request = JSON.parse(
      await Deno.readTextFile(campaign.config.loop.restartRequestPath),
    ) as RestartRequest;
    await Deno.remove(campaign.config.loop.restartRequestPath);
    return request;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
}

async function restartCampaignPhase(campaign: ResolvedCampaign, phase: string): Promise<void> {
  const service = campaign.config.loop.controllerService;
  if (!service) throw new Error("Campaign does not declare a continuous controller service");
  await writeJsonAtomic(
    campaign.config.loop.restartRequestPath,
    {
      version: 1,
      phase,
      requestedAt: new Date().toISOString(),
    } satisfies RestartRequest,
  );
  await commandOutput([
    "/usr/bin/systemctl",
    "--user",
    "kill",
    "--kill-whom=all",
    "--signal=SIGKILL",
    service,
  ]);
  const output = await commandOutput([
    "/usr/bin/systemctl",
    "--user",
    "restart",
    "--no-block",
    service,
  ]);
  if (!output.success) {
    throw new Error(
      new TextDecoder().decode(output.stderr).trim() || `Could not restart ${service}`,
    );
  }
}

async function updateWorkerPauseStatus(
  campaign: ResolvedCampaign,
  pausedAt: string,
): Promise<void> {
  const worker = campaign.environment.config.worker;
  if (!worker) return;
  const path = join(worker.metricsDirectory, "current.json");
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(await Deno.readTextFile(path)) as Record<string, unknown>;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  await writeJsonAtomic(path, {
    ...current,
    status: "paused",
    phase: undefined,
    phaseStartedAt: undefined,
    pausedAt,
  });
}

async function pauseCampaign(campaign: ResolvedCampaign): Promise<void> {
  const service = campaign.config.loop.controllerService;
  if (!service) throw new Error("Campaign does not declare a continuous controller service");
  const pausePath = campaign.config.loop.pausePath;
  if (!pausePath) throw new Error("Campaign does not declare loop.pausePath");
  await writeJsonAtomic(pausePath, {
    version: 1,
    pausedAt: new Date().toISOString(),
  });
  if (await serviceActive(service)) {
    await commandOutput([
      "/usr/bin/systemctl",
      "--user",
      "kill",
      "--kill-whom=all",
      "--signal=SIGKILL",
      service,
    ]);
  }
  await systemctl(["stop", service]);
  const release = await acquireCampaignLock(campaign.config.resources.lockPath);
  try {
    await terminateEvaluatorListener(campaign);
    await stopWorkerServices(campaign);
    await waitForGpuQuiescence(campaign);
    const pausedAt = new Date().toISOString();
    const journal = await readJournal(campaign);
    await writePhase(campaign, journal, "PAUSED", {
      activeCandidate: undefined,
      lastError: undefined,
    });
    await updateWorkerPauseStatus(campaign, pausedAt);
    await systemctl([
      "reset-failed",
      service,
      ...campaign.config.resources.workerServices,
    ]);
    console.log(`Campaign paused; GPU services are stopped (${pausedAt})`);
  } finally {
    await release();
  }
}

async function resumeCampaign(campaign: ResolvedCampaign): Promise<void> {
  const service = campaign.config.loop.controllerService;
  if (!service) throw new Error("Campaign does not declare a continuous controller service");
  const pausePath = campaign.config.loop.pausePath;
  if (!pausePath) throw new Error("Campaign does not declare loop.pausePath");
  const journal = await readJournal(campaign);
  if (journal.phase !== "PAUSED" && await serviceActive(service)) {
    console.log("Campaign is already running");
    return;
  }
  await writePhase(campaign, journal, "VULKAN_STARTING", {
    activeCandidate: undefined,
    lastError: undefined,
  });
  await Deno.remove(pausePath).catch((error) => {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  });
  await systemctl(["start", "--no-block", service]);
  console.log("Campaign resume requested; the next worker cycle starts at discovery");
}

async function notifyCampaignWorker(campaign: ResolvedCampaign, message: string): Promise<void> {
  const worker = campaign.environment.config.worker;
  if (!worker) throw new Error("Campaign environment does not declare a worker");
  await writeJsonAtomic(worker.liveNoticePath, {
    version: 1,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    message,
  });
  console.log(`Queued live campaign update: ${worker.liveNoticePath}`);
}

async function syncModelMetadata(campaign: ResolvedCampaign): Promise<void> {
  const model = campaign.config.evaluator.model;
  const declaration = model.metadata;
  let artifact: Record<string, unknown> | undefined;
  try {
    artifact = JSON.parse(await Deno.readTextFile(declaration.hostPath)) as Record<string, unknown>;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound) && !(error instanceof SyntaxError)) throw error;
  }
  const source = artifact?.source && typeof artifact.source === "object"
    ? artifact.source as Record<string, unknown>
    : undefined;
  if (source?.sha256 !== model.sha256) {
    const output = await commandOutput(declaration.command.argv, {
      env: declaration.command.environment,
    });
    if (!output.success) {
      throw new Error(
        new TextDecoder().decode(output.stderr).trim() || "GGUF metadata extraction failed",
      );
    }
    const raw = JSON.parse(new TextDecoder().decode(output.stdout)) as {
      endian?: string;
      metadata?: Record<string, { type?: string; value?: unknown }>;
      tensors?: Record<string, { shape?: number[]; type?: string }>;
    };
    const metadata = Object.fromEntries(
      Object.entries(raw.metadata ?? {}).flatMap(([key, entry]) => {
        if (entry.value === undefined || key === "tokenizer.chat_template") return [];
        return [[key, { type: entry.type ?? null, value: entry.value }]];
      }),
    );
    const tensors = raw.tensors ?? {};
    const tensorTypeCounts: Record<string, number> = {};
    for (const tensor of Object.values(tensors)) {
      const type = tensor.type ?? "unknown";
      tensorTypeCounts[type] = (tensorTypeCounts[type] ?? 0) + 1;
    }
    artifact = {
      version: 1,
      source: { path: model.path, size: model.size, sha256: model.sha256 },
      generatedAt: new Date().toISOString(),
      endian: raw.endian ?? null,
      metadata,
      tensorTypeCounts,
      tensors,
    };
    await writeJsonAtomic(declaration.hostPath, artifact);
  }

  const { backend, guest } = campaign.environment.config;
  const mkdir = await commandOutput([
    backend.executable,
    "exec",
    backend.instance,
    "--",
    "mkdir",
    "-p",
    dirname(declaration.guestPath),
  ]);
  if (!mkdir.success) throw new Error("Could not create guest model-metadata directory");
  const push = await commandOutput([
    backend.executable,
    "file",
    "push",
    declaration.hostPath,
    `${backend.instance}${declaration.guestPath}`,
  ]);
  if (!push.success) throw new Error("Could not copy model metadata into guest");
  const own = await commandOutput([
    backend.executable,
    "exec",
    backend.instance,
    "--",
    "chown",
    `${guest.uid}:${guest.gid}`,
    declaration.guestPath,
  ]);
  if (!own.success) throw new Error("Could not set guest model-metadata ownership");
  console.log(`Model metadata ready: ${declaration.guestPath}`);
}

async function evaluateCurrent(
  campaign: ResolvedCampaign,
  stopTier: string,
): Promise<EvaluationResult> {
  const release = await acquireCampaignLock(campaign.config.resources.lockPath);
  let journal = await readJournal(campaign);
  let mustRestore = false;
  try {
    await ensureEnvironmentRunning(campaign);
    const active = await Promise.all(
      campaign.config.resources.workerServices.map((service) => serviceActive(service)),
    );
    mustRestore = active.some(Boolean);
    const id = `manual-${Date.now()}`;
    const candidate = await exportGuestCandidate(campaign, id);
    journal = await writePhase(campaign, journal, "CANDIDATE_EXPORTED", {
      activeCandidate: candidate,
    });
    const evaluated = await evaluateExportedCandidate(
      campaign,
      journal,
      candidate,
      stopTier,
      false,
    );
    journal = evaluated.journal;
    return evaluated.evaluation;
  } finally {
    if (mustRestore) await reconcileForWorker(campaign, journal);
    await release();
  }
}

function evaluationSummary(result: EvaluationResult): string {
  if (result.probe) {
    const outcome = result.probe.executionSucceeded
      ? "execution completed; evidence requires model interpretation"
      : result.failure ?? "execution failed";
    return `${result.candidate.id}: probe ${result.probe.runner}:${result.probe.path} ${outcome} ` +
      `in ${(result.probe.wallMs / 1000).toFixed(2)}s; accepted=false`;
  }
  const tiers = result.tiers.map((tier) =>
    `${tier.name}=${(tier.medianWallMs / 1000).toFixed(2)}s ` +
    `(${tier.improvementPercent >= 0 ? "+" : ""}${tier.improvementPercent.toFixed(2)}%)`
  ).join(", ");
  return `${result.candidate.id}: ${result.failure ? `failed: ${result.failure}` : tiers}; ` +
    `accepted=${result.accepted}`;
}

export async function campaignCommand(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(campaignUsage());
    return;
  }
  let path = DEFAULT_CAMPAIGN;
  let action:
    | "check"
    | "dry-run"
    | "status"
    | "evaluate-current"
    | "cycle-once"
    | "loop"
    | "pause"
    | "resume"
    | "restart-phase"
    | "notify"
    | "sync-model-metadata"
    | undefined;
  let stopTier: string | undefined;
  let startPhase: string | undefined;
  let notification: string | undefined;
  let positionalSeen = false;
  const setAction = (next: typeof action) => {
    if (action) throw new Error("Select exactly one campaign action");
    action = next;
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--check") setAction("check");
    else if (arg === "--dry-run") setAction("dry-run");
    else if (arg === "--status") setAction("status");
    else if (arg === "--evaluate-current") setAction("evaluate-current");
    else if (arg === "--cycle-once") setAction("cycle-once");
    else if (arg === "--loop") setAction("loop");
    else if (arg === "--pause") setAction("pause");
    else if (arg === "--resume") setAction("resume");
    else if (arg === "--restart-phase") {
      setAction("restart-phase");
      startPhase = args[++index];
      if (!startPhase) throw new Error("--restart-phase requires a name");
    } else if (arg === "--notify") {
      setAction("notify");
      notification = args[++index];
      if (!notification) throw new Error("--notify requires a message");
    } else if (arg === "--sync-model-metadata") setAction("sync-model-metadata");
    else if (arg === "--tier") {
      stopTier = args[++index];
      if (!stopTier) throw new Error("--tier requires a name");
    } else if (arg === "--start-phase") {
      startPhase = args[++index];
      if (!startPhase) throw new Error("--start-phase requires a name");
    } else if (arg.startsWith("-")) throw new Error(`Unknown campaign option: ${arg}`);
    else if (positionalSeen) throw new Error("Only one campaign CONFIG is accepted");
    else {
      path = arg;
      positionalSeen = true;
    }
  }
  if (!action) throw new Error(`A campaign action is required\n\n${campaignUsage()}`);
  if (stopTier && action !== "evaluate-current") {
    throw new Error("--tier is only valid with --evaluate-current");
  }
  if (startPhase && action !== "cycle-once" && action !== "restart-phase") {
    throw new Error("A worker phase is only valid with --cycle-once or --restart-phase");
  }
  const campaign = await loadCampaign(path);
  await validateCampaign(campaign);
  if (
    startPhase &&
    !campaign.environment.config.worker?.phases?.some((phase) => phase.name === startPhase)
  ) {
    throw new Error(`Unknown worker start phase: ${startPhase}`);
  }
  if (stopTier && !campaign.config.evaluator.tiers.some((tier) => tier.name === stopTier)) {
    throw new Error(`Unknown evaluator tier: ${stopTier}`);
  }
  if (action === "check") {
    console.log(`Valid campaign: ${campaign.config.name} (${campaign.sourcePath})`);
  } else if (action === "dry-run") printCampaignPlan(campaign);
  else if (action === "status") console.log(JSON.stringify(await readJournal(campaign), null, 2));
  else if (action === "evaluate-current") {
    console.log(evaluationSummary(await evaluateCurrent(campaign, stopTier ?? "screen")));
  } else if (action === "loop") await runCampaignLoop(campaign);
  else if (action === "pause") await pauseCampaign(campaign);
  else if (action === "resume") await resumeCampaign(campaign);
  else if (action === "restart-phase") await restartCampaignPhase(campaign, startPhase!);
  else if (action === "notify") await notifyCampaignWorker(campaign, notification!);
  else if (action === "sync-model-metadata") await syncModelMetadata(campaign);
  else console.log(evaluationSummary(await runCycleOnce(campaign, startPhase)));
}
