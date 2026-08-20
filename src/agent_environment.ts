import { Ajv2020, type ErrorObject } from "npm:ajv@8.17.1/dist/2020.js";
import { basename, dirname, resolve } from "jsr:@std/path@1";
import { loadDeployment, type ResolvedDeployment } from "./deployment.ts";
import { assertFile, shellQuote } from "./llama.ts";
import { proxyCommand } from "./proxy.ts";
import { serveWorkerDashboard } from "./agent_dashboard.ts";
import { runWorkerLoop, runWorkerOnce } from "./agent_worker.ts";

const PROJECT_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const ENVIRONMENT_SCHEMA = `${PROJECT_ROOT}/schemas/agent-environment.schema.json`;
const DEFAULT_ENVIRONMENT = `${PROJECT_ROOT}/environments/ps2-linux.json`;

export interface AgentEnvironmentConfig {
  $schema?: string;
  version: 1;
  name: string;
  modelDeployment: string;
  seedOnCreate: boolean;
  backend: {
    kind: "incus";
    executable: string;
    instance: string;
    image: string;
    network: { name: string; device: string };
    limits: { cpu: number; memory: string; processes: number };
    modelAccess: { host: string; port: number };
  };
  guest: {
    user: string;
    uid: number;
    gid: number;
    home: string;
    workspace: string;
    packages: string[];
  };
  worker?: {
    transport: "exec-json" | "app-server";
    prompt: string;
    state: string;
    metricsDirectory: string;
    dashboardPort: number;
    timeoutSeconds: number;
    cooldownSeconds: number;
    progressRepositories: string[];
    cleanupProcesses: string[];
  };
  seeds: Array<{ source: string; target: string; exclude: string[]; refresh: boolean }>;
}

export interface ResolvedAgentEnvironment {
  sourcePath: string;
  config: AgentEnvironmentConfig;
  model: ResolvedDeployment;
}

export interface CommandSpec {
  executable: string;
  args: string[];
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? []).map((error) => {
    const location = error.instancePath || "/";
    return `${location}: ${error.message ?? error.keyword}`;
  }).join("\n");
}

export function environmentUsage(): string {
  return `Usage: lm env [CONFIG] ACTION [-- COMMAND...]

Manage a disposable agent workspace. CONFIG defaults to:
  ${DEFAULT_ENVIRONMENT}

Actions:
  --check     Validate schema, model reference, executables, and seed sources
  --dry-run   Print the resolved Incus reconciliation and seed plan
  --apply     Create/reconcile and start the declared Incus instance
  --provision Install/update the declared guest packages as container root
  --seed      Copy declared sources into the instance (never bind-mounts them)
  --refresh   Refresh only declared control files; preserve guest workspace edits
  --model-proxy  Expose the host model only on the declared Incus bridge address
  --worker-once  Run one fresh, bounded agent turn and record campaign metrics
  --worker-loop  Continuously run fresh turns with the declared cooldown
  --worker-metrics  Print the cumulative campaign ledger
  --worker-dashboard  Serve the live human-overview UI on localhost
  --status    Show the instance and its configured devices
  --exec      Run COMMAND as the declared guest user in its workspace
  --help      Show this help`;
}

export async function loadAgentEnvironment(path: string): Promise<ResolvedAgentEnvironment> {
  const sourcePath = resolve(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await Deno.readTextFile(sourcePath));
  } catch (error) {
    throw new Error(
      `Could not read agent environment ${sourcePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const schema = JSON.parse(await Deno.readTextFile(ENVIRONMENT_SCHEMA));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate = ajv.compile(schema);
  if (!validate(parsed)) {
    throw new Error(
      `Invalid agent environment ${sourcePath}:\n${formatAjvErrors(validate.errors)}`,
    );
  }
  const config = parsed as AgentEnvironmentConfig;
  const model = await loadDeployment(resolve(dirname(sourcePath), config.modelDeployment));
  return { sourcePath, config, model };
}

function modelEndpoint(environment: ResolvedAgentEnvironment): { host: string; port: number } {
  const config = environment.model.config;
  if (config.backend.kind !== "llama.cpp") {
    throw new Error("Agent environments currently require a llama.cpp model deployment");
  }
  return environment.model.proxy?.listen ?? config.backend.listen;
}

export function buildApplyPlan(environment: ResolvedAgentEnvironment): CommandSpec[] {
  const { backend } = environment.config;
  const incus = backend.executable;
  return [
    { executable: incus, args: ["network", "show", backend.network.name] },
    { executable: incus, args: ["init", backend.image, backend.instance] },
    {
      executable: incus,
      args: [
        "config",
        "set",
        backend.instance,
        "security.privileged=false",
        "security.nesting=false",
        `limits.cpu=${backend.limits.cpu}`,
        `limits.memory=${backend.limits.memory}`,
        `limits.processes=${backend.limits.processes}`,
      ],
    },
    { executable: incus, args: ["start", backend.instance] },
  ];
}

export function buildSeedCommands(environment: ResolvedAgentEnvironment): CommandSpec[] {
  const { backend, seeds } = environment.config;
  return seeds.flatMap((seed): CommandSpec[] => {
    const create = {
      executable: backend.executable,
      args: ["exec", backend.instance, "--", "mkdir", "-p", dirname(seed.target)],
    };
    const ownParent = {
      executable: backend.executable,
      args: [
        "exec",
        backend.instance,
        "--",
        "chown",
        `${environment.config.guest.uid}:${environment.config.guest.gid}`,
        dirname(seed.target),
      ],
    };
    const ownTarget = {
      executable: backend.executable,
      args: [
        "exec",
        backend.instance,
        "--",
        "chown",
        "-R",
        `${environment.config.guest.uid}:${environment.config.guest.gid}`,
        seed.target,
      ],
    };
    const sourceName = basename(seed.source);
    return [
      create,
      {
        executable: "/usr/bin/tar",
        args: [
          "-C",
          dirname(seed.source),
          "-cpf",
          "-",
          ...seed.exclude.map((pattern) => `--exclude=${sourceName}/${pattern}`),
          sourceName,
        ],
      },
      {
        executable: backend.executable,
        args: [
          "exec",
          backend.instance,
          "--",
          "tar",
          "-xpf",
          "-",
          "-C",
          dirname(seed.target),
        ],
      },
      ownParent,
      ownTarget,
    ];
  });
}

export function buildProvisionCommand(environment: ResolvedAgentEnvironment): CommandSpec {
  const { backend, guest } = environment.config;
  return {
    executable: backend.executable,
    args: [
      "exec",
      backend.instance,
      "--",
      "pacman",
      "-Syu",
      "--noconfirm",
      "--needed",
      ...guest.packages,
    ],
  };
}

function formatCommand(command: CommandSpec): string {
  return [command.executable, ...command.args].map(shellQuote).join(" ");
}

async function run(command: CommandSpec, inherit = true): Promise<Deno.CommandOutput> {
  const output = await new Deno.Command(command.executable, {
    args: command.args,
    stdin: inherit ? "inherit" : "null",
    stdout: inherit ? "inherit" : "piped",
    stderr: inherit ? "inherit" : "piped",
  }).output();
  if (!output.success) {
    const stderr = inherit ? "" : new TextDecoder().decode(output.stderr).trim();
    throw new Error(
      `Command failed (${output.code}): ${formatCommand(command)}${stderr ? `\n${stderr}` : ""}`,
    );
  }
  return output;
}

async function succeeds(command: CommandSpec): Promise<boolean> {
  const output = await new Deno.Command(command.executable, {
    args: command.args,
    stdin: "null",
    stdout: "null",
    stderr: "null",
  }).output();
  return output.success;
}

async function validateEnvironment(environment: ResolvedAgentEnvironment): Promise<void> {
  const { backend, guest, seeds } = environment.config;
  await assertFile(backend.executable, "Incus client", true);
  if (!guest.home.startsWith("/") || !guest.workspace.startsWith("/")) {
    throw new Error("Guest home and workspace must be absolute paths");
  }
  for (const seed of seeds) {
    if (!seed.target.startsWith("/")) {
      throw new Error(`Seed target must be absolute: ${seed.target}`);
    }
    const source = await Deno.lstat(seed.source).catch(() => undefined);
    if (!source) throw new Error(`Seed source not found: ${seed.source}`);
  }
  modelEndpoint(environment);
}

async function applyEnvironment(environment: ResolvedAgentEnvironment): Promise<void> {
  const { backend, guest } = environment.config;
  const incus = backend.executable;
  await run({ executable: incus, args: ["network", "show", backend.network.name] }, false);
  const exists = await succeeds({ executable: incus, args: ["config", "show", backend.instance] });
  const created = !exists;
  if (!exists) {
    console.log(`Creating Incus instance ${backend.instance} from ${backend.image}`);
    await run({ executable: incus, args: ["init", backend.image, backend.instance] });
  }
  await run(buildApplyPlan(environment)[2]);

  const running = await succeeds({
    executable: incus,
    args: ["exec", backend.instance, "--", "true"],
  });
  if (!running) await run({ executable: incus, args: ["start", backend.instance] });
  if (created) await provisionEnvironment(environment);

  const userExists = await succeeds({
    executable: incus,
    args: ["exec", backend.instance, "--", "getent", "passwd", String(guest.uid)],
  });
  if (!userExists) {
    await run({
      executable: incus,
      args: ["exec", backend.instance, "--", "groupadd", "--gid", String(guest.gid), guest.user],
    });
    await run({
      executable: incus,
      args: [
        "exec",
        backend.instance,
        "--",
        "useradd",
        "--uid",
        String(guest.uid),
        "--gid",
        String(guest.gid),
        "--create-home",
        "--home-dir",
        guest.home,
        "--shell",
        "/bin/bash",
        guest.user,
      ],
    });
  }
  await run({
    executable: incus,
    args: ["exec", backend.instance, "--", "mkdir", "-p", guest.workspace, `${guest.home}/.codex`],
  });
  await run({
    executable: incus,
    args: [
      "exec",
      backend.instance,
      "--",
      "chown",
      "-R",
      `${guest.uid}:${guest.gid}`,
      guest.home,
    ],
  });
  if (created && environment.config.seedOnCreate) await seedEnvironment(environment);
  console.log(`Ready agent environment: ${environment.config.name} (${backend.instance})`);
}

async function provisionEnvironment(environment: ResolvedAgentEnvironment): Promise<void> {
  console.log(`Provisioning guest packages in ${environment.config.backend.instance}`);
  await run(buildProvisionCommand(environment));
}

async function serveModelProxy(environment: ResolvedAgentEnvironment): Promise<void> {
  const modelBackend = environment.model.config.backend;
  if (modelBackend.kind !== "llama.cpp") {
    throw new Error("Agent model proxy currently requires a llama.cpp backend");
  }
  const access = environment.config.backend.modelAccess;
  await proxyCommand([
    "--listen-host",
    access.host,
    "--listen-port",
    String(access.port),
    "--upstream",
    `http://${modelBackend.listen.host}:${modelBackend.listen.port}`,
  ]);
}

async function copySeed(
  environment: ResolvedAgentEnvironment,
  seed: AgentEnvironmentConfig["seeds"][number],
): Promise<void> {
  const { backend } = environment.config;
  await run({
    executable: backend.executable,
    args: ["exec", backend.instance, "--", "mkdir", "-p", dirname(seed.target)],
  });
  const sourceName = basename(seed.source);
  if (sourceName !== basename(seed.target)) {
    throw new Error(
      `Seed source and target basenames must match: ${seed.source} -> ${seed.target}`,
    );
  }
  const archive = new Deno.Command("/usr/bin/tar", {
    args: [
      "-C",
      dirname(seed.source),
      "-cpf",
      "-",
      ...seed.exclude.map((pattern) => `--exclude=${sourceName}/${pattern}`),
      sourceName,
    ],
    stdin: "null",
    stdout: "piped",
    stderr: "inherit",
  }).spawn();
  const extract = new Deno.Command(backend.executable, {
    args: [
      "exec",
      backend.instance,
      "--",
      "tar",
      "-xpf",
      "-",
      "-C",
      dirname(seed.target),
    ],
    stdin: "piped",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  const pipe = archive.stdout.pipeTo(extract.stdin);
  const [archiveStatus, extractStatus] = await Promise.all([
    archive.status,
    extract.status,
    pipe,
  ]);
  if (!archiveStatus.success || !extractStatus.success) {
    throw new Error(
      `Seed copy failed (${archiveStatus.code}/${extractStatus.code}): ${seed.source}`,
    );
  }
  await run({
    executable: backend.executable,
    args: [
      "exec",
      backend.instance,
      "--",
      "chown",
      `${environment.config.guest.uid}:${environment.config.guest.gid}`,
      dirname(seed.target),
    ],
  });
  await run({
    executable: backend.executable,
    args: [
      "exec",
      backend.instance,
      "--",
      "chown",
      "-R",
      `${environment.config.guest.uid}:${environment.config.guest.gid}`,
      seed.target,
    ],
  });
}

async function seedEnvironment(
  environment: ResolvedAgentEnvironment,
  refreshOnly = false,
): Promise<void> {
  for (const seed of environment.config.seeds) {
    if (refreshOnly && !seed.refresh) continue;
    console.log(`Copying ${seed.source} -> ${seed.target}`);
    if (seed.exclude.length > 0) console.log(`  excluding: ${seed.exclude.join(", ")}`);
    await copySeed(environment, seed);
  }
}

async function showStatus(environment: ResolvedAgentEnvironment): Promise<void> {
  const { backend } = environment.config;
  await run({ executable: backend.executable, args: ["list", backend.instance] });
  await run({
    executable: backend.executable,
    args: ["config", "device", "show", backend.instance],
  });
}

async function showWorkerMetrics(environment: ResolvedAgentEnvironment): Promise<void> {
  const worker = environment.config.worker;
  if (!worker) throw new Error("This agent environment does not declare a worker");
  const path = `${worker.metricsDirectory}/campaign.json`;
  try {
    console.log(await Deno.readTextFile(path));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      console.log(`No worker campaign has been recorded yet: ${path}`);
      return;
    }
    throw error;
  }
}

async function execEnvironment(
  environment: ResolvedAgentEnvironment,
  command: string[],
): Promise<void> {
  if (command.length === 0) throw new Error("--exec requires a command after --");
  const { backend, guest } = environment.config;
  await run({
    executable: backend.executable,
    args: [
      "exec",
      backend.instance,
      "--user",
      String(guest.uid),
      "--group",
      String(guest.gid),
      "--cwd",
      guest.workspace,
      "--env",
      `HOME=${guest.home}`,
      "--",
      ...command,
    ],
  });
}

export async function environmentCommand(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(environmentUsage());
    return;
  }
  const separator = args.indexOf("--");
  const ownArgs = separator === -1 ? args : args.slice(0, separator);
  const execArgs = separator === -1 ? [] : args.slice(separator + 1);
  let path = DEFAULT_ENVIRONMENT;
  let action:
    | "check"
    | "dry-run"
    | "apply"
    | "provision"
    | "seed"
    | "refresh"
    | "model-proxy"
    | "worker-once"
    | "worker-loop"
    | "worker-metrics"
    | "worker-dashboard"
    | "status"
    | "exec"
    | undefined;
  const setAction = (next: typeof action) => {
    if (action) throw new Error("Select exactly one agent-environment action");
    action = next;
  };
  for (const arg of ownArgs) {
    if (arg === "--check") setAction("check");
    else if (arg === "--dry-run") setAction("dry-run");
    else if (arg === "--apply") setAction("apply");
    else if (arg === "--provision") setAction("provision");
    else if (arg === "--seed") setAction("seed");
    else if (arg === "--refresh") setAction("refresh");
    else if (arg === "--model-proxy") setAction("model-proxy");
    else if (arg === "--worker-once") setAction("worker-once");
    else if (arg === "--worker-loop") setAction("worker-loop");
    else if (arg === "--worker-metrics") setAction("worker-metrics");
    else if (arg === "--worker-dashboard") setAction("worker-dashboard");
    else if (arg === "--status") setAction("status");
    else if (arg === "--exec") setAction("exec");
    else if (arg.startsWith("-")) throw new Error(`Unknown env option: ${arg}`);
    else if (path !== DEFAULT_ENVIRONMENT) {
      throw new Error("Only one environment CONFIG is accepted");
    } else path = arg;
  }
  if (!action) throw new Error(`An action is required\n\n${environmentUsage()}`);
  if (action !== "exec" && execArgs.length > 0) {
    throw new Error("Command argv is only valid with --exec");
  }

  const environment = await loadAgentEnvironment(path);
  await validateEnvironment(environment);
  if (action === "check") {
    console.log(`Valid agent environment: ${environment.config.name} (${environment.sourcePath})`);
  } else if (action === "dry-run") {
    console.log(`Environment: ${environment.config.name}`);
    console.log(`Instance:    ${environment.config.backend.instance}`);
    console.log(`Model:       ${environment.model.config.name}`);
    console.log(
      `Model API:   http://${environment.config.backend.modelAccess.host}:${environment.config.backend.modelAccess.port}/v1`,
    );
    for (const command of buildApplyPlan(environment)) console.log(formatCommand(command));
    console.log(formatCommand(buildProvisionCommand(environment)));
    const seedCommands = buildSeedCommands(environment);
    for (let index = 0; index < seedCommands.length; index += 5) {
      console.log(formatCommand(seedCommands[index]));
      console.log(
        `${formatCommand(seedCommands[index + 1])} | ${formatCommand(seedCommands[index + 2])}`,
      );
      console.log(formatCommand(seedCommands[index + 3]));
      console.log(formatCommand(seedCommands[index + 4]));
    }
  } else if (action === "apply") await applyEnvironment(environment);
  else if (action === "provision") await provisionEnvironment(environment);
  else if (action === "seed") await seedEnvironment(environment);
  else if (action === "refresh") await seedEnvironment(environment, true);
  else if (action === "model-proxy") await serveModelProxy(environment);
  else if (action === "worker-once") {
    const { run, ledger } = await runWorkerOnce(environment);
    console.log(
      `Worker ${run.id}: exit=${run.exitCode}, ${run.durationSeconds.toFixed(1)}s, ` +
        `${run.usage.totalTokens.toLocaleString("en-US")} tokens`,
    );
    console.log(
      `Campaign: ${ledger.runs} runs, ${(ledger.wallSeconds / 3600).toFixed(2)} hours, ` +
        `${ledger.usage.totalTokens.toLocaleString("en-US")} tokens`,
    );
    if (run.finalMessage) console.log(run.finalMessage.trim());
    if (run.exitCode !== 0) throw new Error(`Worker exited with status ${run.exitCode}`);
  } else if (action === "worker-loop") await runWorkerLoop(environment);
  else if (action === "worker-metrics") await showWorkerMetrics(environment);
  else if (action === "worker-dashboard") await serveWorkerDashboard(environment);
  else if (action === "status") await showStatus(environment);
  else await execEnvironment(environment, execArgs);
}
