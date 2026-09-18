import { Ajv2020, type ErrorObject } from "npm:ajv@8.17.1/dist/2020.js";
import { basename, dirname, resolve } from "jsr:@std/path@1";
import { loadDeployment, type ResolvedDeployment } from "./deployment.ts";
import { assertFile, shellQuote } from "./llama.ts";
import { proxyCommand } from "./proxy.ts";
import { serveHarnessDashboard } from "./harness_dashboard.ts";
import { runAttemptLoop, runAttemptOnce } from "./harness_attempt.ts";

const PROJECT_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const ENVIRONMENT_SCHEMA = `${PROJECT_ROOT}/schemas/agent-environment.schema.json`;

export interface AttemptHarness {
  kind: "turn-loop";
  adapter: "exec-json" | "app-server" | "pi-rpc" | "omp-rpc";
  command?: string[];
  model?: string;
  prompt: string;
  state: string;
  metricsDirectory: string;
  liveNoticePath: string;
  dashboardPort: number;
  timeoutSeconds: number;
  wrapUpSeconds?: number;
  compaction?: {
    mode: "model-directed";
    maxPerSession: number;
    reminderTokens: number;
  };
  phases?: Array<{
    name: string;
    prompt: string;
    timeoutSeconds: number;
    wrapUpSeconds: number;
    finalizeTimeoutSeconds?: number;
    requiredChangedFiles: string[];
  }>;
  phaseControl?: {
    requestPath: string;
    maxTransitions: number;
    maxWallSeconds: number;
    finalPhase: string;
  };
  turnSummary?: {
    endpoint: string;
    model: string;
    reasoningEffort: "none" | "low" | "medium" | "high";
    timeoutSeconds: number;
    maxInputChars: number;
    maxOutputTokens: number;
  };
  cooldownSeconds: number;
  progressRepositories: string[];
  cleanupProcesses: string[];
}

export interface ServiceHarness {
  kind: "service";
  command: string[];
  environment?: Record<string, string>;
  environmentInputs?: Array<{ source: string; key: string }>;
  secretInputs?: Array<{ source: string; key: string; target: string }>;
  setup?: Array<{
    name: string;
    check: string[];
    checkJson?: Array<{ pointer: string; equals: string | number | boolean | null }>;
    command: string[];
    registryIntegrity?: { package: string; version: string; integrity: string };
  }>;
  unit: string;
  restart: "no" | "on-failure" | "always";
  restartSeconds: number;
  restartPreventExitStatuses: number[];
  ready: { command: string[]; timeoutSeconds: number };
  restartOnRefresh: boolean;
  adapter?: never;
  prompt?: never;
  state?: never;
  metricsDirectory?: never;
  liveNoticePath?: never;
  dashboardPort?: never;
  timeoutSeconds?: never;
  wrapUpSeconds?: never;
  compaction?: never;
  phases?: never;
  phaseControl?: never;
  turnSummary?: never;
  cooldownSeconds?: never;
  progressRepositories?: never;
  cleanupProcesses?: never;
}

export interface AgentEnvironmentConfig {
  $schema?: string;
  version: 2;
  name: string;
  modelDeployment: string;
  seedOnCreate: boolean;
  backend: {
    kind: "incus";
    executable: string;
    instance: string;
    image: string;
    network: { name: string; device: string; address?: string };
    limits: { cpu: number; memory: string; processes: number };
    lifecycle?: { createIfMissing: boolean; deleteProtection: boolean; autostart: boolean };
    modelAccess: { host: string; port: number };
  };
  guest: {
    user: string;
    uid: number;
    gid: number;
    home: string;
    workspace: string;
    packages: string[];
    administration?: { passwordlessSudo: boolean; linger: boolean };
    npmPackages?: Array<{
      name: string;
      version: string;
      integrity?: string;
      source?: string;
      allowLifecycleScripts: boolean;
    }>;
  };
  hostServices?: Array<{
    source: string;
    enabled: boolean;
    running: boolean;
    restartOnRefresh: boolean;
    environmentInputs?: Array<{ source: string; key: string }>;
  }>;
  readOnlyMounts?: Array<{
    name: string;
    source: string;
    target: string;
  }>;
  harness?: AttemptHarness | ServiceHarness;
  exposure?: {
    services: Array<{
      name: string;
      guestPort?: number;
      upstream?: string;
      host?: { address: "127.0.0.1"; port: number };
      tailscaleServe?: { enabled: true; executable: string; httpsPort: number };
    }>;
  };
  seeds: Array<{
    source: string;
    target: string;
    exclude: string[];
    policy: "create" | "refresh" | "manual";
    mode?: string;
  }>;
}

export interface ResolvedAgentEnvironment {
  sourcePath: string;
  config: AgentEnvironmentConfig;
  model: ResolvedDeployment | null;
}

export interface CommandSpec {
  executable: string;
  args: string[];
}

interface SeedArchivePlan {
  command: CommandSpec;
  stdin?: Uint8Array;
  mode: "git" | "recursive";
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? []).map((error) => {
    const location = error.instancePath || "/";
    return `${location}: ${error.message ?? error.keyword}`;
  }).join("\n");
}

export function environmentUsage(): string {
  return `Usage: lm env CONFIG ACTION [-- COMMAND...]

Manage a declarative agent workspace.

Actions:
  --check     Validate schema, model reference, executables, and seed sources
  --dry-run   Print the resolved Incus reconciliation and seed plan
  --apply     Create/reconcile and start the declared Incus instance
  --provision Install/update the declared guest packages as container root
  --seed      Copy declared sources into the instance (never bind-mounts them)
  --force-seed  Explicitly overwrite every declared seed, including create/manual state
  --refresh   Refresh declared control files and host services; preserve guest workspace edits
  --model-proxy  Expose the host model only on the declared Incus bridge address
  --attempt-once  Run one fresh, bounded agent turn and record campaign metrics
  --attempt-loop  Continuously run fresh turns with the declared cooldown
  --attempt-metrics  Print the cumulative campaign ledger
  --attempt-dashboard  Serve the live human-overview UI on localhost
  --service-start  Reconcile and start a declared service harness and its exposure
  --service-restart  Refresh secrets/configuration and restart a declared service harness
  --service-stop  Stop a declared service harness and remove its Tailscale Serve route
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
  const model = environment.model;
  if (!model || model.config.backend.kind !== "llama.cpp") {
    throw new Error("Agent environments currently require a llama.cpp model deployment");
  }
  return model.proxy?.listen ?? model.config.backend.listen;
}

export function buildNetworkAddressCommand(
  environment: ResolvedAgentEnvironment,
  deviceExists: boolean,
): CommandSpec | undefined {
  const { backend } = environment.config;
  if (!backend.network.address) return undefined;
  return {
    executable: backend.executable,
    args: [
      "config",
      "device",
      deviceExists ? "set" : "override",
      backend.instance,
      backend.network.device,
      `ipv4.address=${backend.network.address}`,
    ],
  };
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
        ...(backend.lifecycle
          ? [
            `security.protection.delete=${backend.lifecycle.deleteProtection}`,
            `boot.autostart=${backend.lifecycle.autostart}`,
          ]
          : []),
        `limits.cpu=${backend.limits.cpu}`,
        `limits.memory=${backend.limits.memory}`,
        `limits.processes=${backend.limits.processes}`,
      ],
    },
    ...(backend.network.address ? [buildNetworkAddressCommand(environment, false)!] : []),
    ...(environment.config.readOnlyMounts ?? []).map((mount) =>
      buildReadOnlyMountAddCommand(environment, mount)
    ),
    { executable: incus, args: ["start", backend.instance] },
  ];
}

export function buildReadOnlyMountAddCommand(
  environment: ResolvedAgentEnvironment,
  mount: NonNullable<AgentEnvironmentConfig["readOnlyMounts"]>[number],
): CommandSpec {
  return {
    executable: environment.config.backend.executable,
    args: [
      "config",
      "device",
      "add",
      environment.config.backend.instance,
      mount.name,
      "disk",
      `source=${mount.source}`,
      `path=${mount.target}`,
      "readonly=true",
    ],
  };
}

export function buildSeedCommands(environment: ResolvedAgentEnvironment): CommandSpec[] {
  return buildSeedCommandGroups(environment).flat();
}

export function buildSeedCommandGroups(environment: ResolvedAgentEnvironment): CommandSpec[][] {
  const { backend, seeds } = environment.config;
  return seeds.map((seed): CommandSpec[] => {
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
    const archive = buildSeedArchive(seed);
    const commands = [
      create,
      archive.command,
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
    if (seed.mode) {
      commands.push({
        executable: backend.executable,
        args: ["exec", backend.instance, "--", "chmod", seed.mode, seed.target],
      });
    }
    return commands;
  });
}

function commandText(command: Deno.CommandOutput): string {
  return new TextDecoder().decode(command.stdout).trim();
}

function gitRootForSeed(source: string): string | undefined {
  const stat = Deno.statSync(source);
  const cwd = stat.isDirectory ? source : dirname(source);
  const output = new Deno.Command("/usr/bin/git", {
    args: ["-C", cwd, "rev-parse", "--show-toplevel"],
    stdin: "null",
    stdout: "piped",
    stderr: "null",
  }).outputSync();
  return output.success ? commandText(output) : undefined;
}

function relativeTo(parent: string, child: string): string {
  const prefix = `${parent.replace(/\/$/, "")}/`;
  if (child === parent) return "";
  if (!child.startsWith(prefix)) throw new Error(`${child} is not beneath ${parent}`);
  return child.slice(prefix.length);
}

export function parseStrictDotenv(text: string, requiredKeys: string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) {
      throw new Error(`dotenv line ${index + 1}: export syntax is not allowed`);
    }
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match) throw new Error(`dotenv line ${index + 1}: expected NAME=value`);
    const [, key, rawValue] = match;
    if (Object.hasOwn(values, key)) throw new Error(`dotenv line ${index + 1}: duplicate ${key}`);
    if (!requiredKeys.includes(key)) throw new Error(`dotenv line ${index + 1}: unexpected ${key}`);
    let value = rawValue;
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else if (/\s|\$\(|`|\\/.test(value)) {
      throw new Error(`dotenv line ${index + 1}: quote whitespace and avoid shell syntax`);
    }
    if (!value) throw new Error(`dotenv line ${index + 1}: ${key} must not be empty`);
    values[key] = value;
  }
  for (const key of requiredKeys) {
    if (!Object.hasOwn(values, key)) throw new Error(`dotenv is missing required key ${key}`);
  }
  return values;
}

async function readSecretSource(
  source: string,
  requiredKeys: string[],
): Promise<Record<string, string>> {
  const stat = await Deno.stat(source).catch(() => undefined);
  if (!stat?.isFile) throw new Error(`Secret input file not found: ${source}`);
  if (stat.mode !== null && (stat.mode & 0o777) !== 0o600) {
    throw new Error(`Secret input file must have mode 0600: ${source}`);
  }
  const ignored = await new Deno.Command("/usr/bin/git", {
    args: ["-C", dirname(source), "check-ignore", "--quiet", "--", source],
    stdin: "null",
    stdout: "null",
    stderr: "null",
  }).output();
  if (!ignored.success) throw new Error(`Secret input file is not ignored by Git: ${source}`);
  return parseStrictDotenv(await Deno.readTextFile(source), requiredKeys);
}

function serviceInputGroups(
  harness: ServiceHarness,
  hostServices: NonNullable<AgentEnvironmentConfig["hostServices"]> = [],
): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  const hostInputs = hostServices.flatMap((service) => service.environmentInputs ?? []);
  for (
    const input of [
      ...(harness.environmentInputs ?? []),
      ...(harness.secretInputs ?? []),
      ...hostInputs,
    ]
  ) {
    const keys = groups.get(input.source) ?? [];
    if (keys.includes(input.key)) {
      throw new Error(`Duplicate service input key ${input.key} in ${input.source}`);
    }
    keys.push(input.key);
    groups.set(input.source, keys);
  }
  return groups;
}

async function readServiceInputs(
  harness: ServiceHarness,
  hostServices: NonNullable<AgentEnvironmentConfig["hostServices"]> = [],
): Promise<Map<string, Record<string, string>>> {
  const values = new Map<string, Record<string, string>>();
  for (const [source, keys] of serviceInputGroups(harness, hostServices)) {
    values.set(source, await readSecretSource(source, keys));
  }
  return values;
}

function serviceEnvironmentInputs(
  harness: ServiceHarness,
  inputs: Map<string, Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries((harness.environmentInputs ?? []).map((input) => [
    input.key,
    inputs.get(input.source)?.[input.key] ??
      (() => {
        throw new Error(`Missing service environment input ${input.key}`);
      })(),
  ]));
}

function seedPathExcluded(path: string, excludes: string[]): boolean {
  if (basename(path) === ".env") return true;
  return excludes.some((pattern) => path === pattern || path.startsWith(`${pattern}/`));
}

export function buildSeedArchive(
  seed: AgentEnvironmentConfig["seeds"][number],
): SeedArchivePlan {
  const source = resolve(seed.source);
  const sourceStat = Deno.statSync(source);
  const sourceName = basename(source);
  if (sourceName === ".env") {
    throw new Error(`Seed source ${source} is a dotenv file; declare secretInputs instead`);
  }
  const root = gitRootForSeed(source);
  // Git-aware filtering keeps ignored build output out of a seeded tree. A seed that
  // names a single file is already explicit, so it is copied even when Git ignores it
  // (built vendor artifacts live in ignored paths by design).
  if (root && sourceStat.isDirectory) {
    const withinRoot = relativeTo(root, source);
    const output = new Deno.Command("/usr/bin/git", {
      args: [
        "-C",
        root,
        "ls-files",
        "-z",
        "--cached",
        "--others",
        "--exclude-standard",
        "--",
        withinRoot || ".",
      ],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).outputSync();
    if (!output.success) {
      throw new Error(
        `Could not enumerate Git-aware seed ${source}: ${new TextDecoder().decode(output.stderr)}`,
      );
    }
    const selected = [
      ...(sourceStat.isDirectory ? [sourceName] : []),
      ...new TextDecoder().decode(output.stdout).split("\0").filter(Boolean).flatMap((rootPath) => {
        const relative = withinRoot
          ? rootPath === withinRoot
            ? basename(rootPath)
            : rootPath.startsWith(`${withinRoot}/`)
            ? rootPath.slice(withinRoot.length + 1)
            : undefined
          : rootPath;
        if (relative === undefined || seedPathExcluded(relative, seed.exclude)) return [];
        return [sourceStat.isDirectory ? `${sourceName}/${relative}` : sourceName];
      }),
    ];
    const stdin = new TextEncoder().encode(selected.length > 0 ? `${selected.join("\0")}\0` : "");
    return {
      mode: "git",
      stdin,
      command: {
        executable: "/usr/bin/tar",
        args: [
          "-C",
          dirname(source),
          "--null",
          "--no-recursion",
          "--files-from=-",
          "-cpf",
          "-",
        ],
      },
    };
  }
  return {
    mode: "recursive",
    command: {
      executable: "/usr/bin/tar",
      args: [
        "-C",
        dirname(source),
        "-cpf",
        "-",
        "--exclude=.env",
        ...seed.exclude.map((pattern) => `--exclude=${sourceName}/${pattern}`),
        sourceName,
      ],
    },
  };
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

export function buildGuestAdministrationCommands(
  environment: ResolvedAgentEnvironment,
): CommandSpec[] {
  const { backend, guest } = environment.config;
  const administration = guest.administration;
  if (!administration) return [];
  const commands: CommandSpec[] = [];
  if (administration.passwordlessSudo) {
    const sudoers = `/etc/sudoers.d/90-lm-tools-${guest.user}`;
    commands.push(
      {
        executable: backend.executable,
        args: ["exec", backend.instance, "--", "chmod", "0440", sudoers],
      },
      {
        executable: backend.executable,
        args: ["exec", backend.instance, "--", "visudo", "--check", "--file", sudoers],
      },
    );
  }
  if (administration.linger) {
    commands.push({
      executable: backend.executable,
      args: ["exec", backend.instance, "--", "loginctl", "enable-linger", guest.user],
    });
  }
  return commands;
}

export function buildGuestUserCommands(environment: ResolvedAgentEnvironment): CommandSpec[] {
  const { backend, guest } = environment.config;
  return [
    {
      executable: backend.executable,
      args: ["exec", backend.instance, "--", "groupadd", "--gid", String(guest.gid), guest.user],
    },
    {
      executable: backend.executable,
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
    },
    {
      executable: backend.executable,
      args: [
        "exec",
        backend.instance,
        "--",
        "mkdir",
        "-p",
        guest.workspace,
        `${guest.home}/.codex`,
      ],
    },
    {
      executable: backend.executable,
      args: [
        "exec",
        backend.instance,
        "--",
        "chown",
        "-R",
        `${guest.uid}:${guest.gid}`,
        guest.home,
      ],
    },
  ];
}

export function buildNpmInstallCommand(
  environment: ResolvedAgentEnvironment,
  npmPackage: NonNullable<AgentEnvironmentConfig["guest"]["npmPackages"]>[number],
): CommandSpec {
  const packageReference = npmPackage.source
    ? `/var/cache/lm-tools/npm/${basename(npmPackage.source)}`
    : `${npmPackage.name}@${npmPackage.version}`;
  return {
    executable: environment.config.backend.executable,
    args: [
      "exec",
      environment.config.backend.instance,
      "--",
      "npm",
      "install",
      "--global",
      "--no-audit",
      "--no-fund",
      "--engine-strict",
      ...(npmPackage.allowLifecycleScripts ? [] : ["--ignore-scripts"]),
      ...(npmPackage.source ? ["--force"] : []),
      packageReference,
    ],
  };
}

export function buildExposureCommands(environment: ResolvedAgentEnvironment): CommandSpec[] {
  const { backend } = environment.config;
  return (environment.config.exposure?.services ?? []).flatMap((service) => {
    const commands: CommandSpec[] = service.host
      ? [{
        executable: backend.executable,
        args: [
          "config",
          "device",
          "add",
          backend.instance,
          service.name,
          "proxy",
          `listen=tcp:${service.host.address}:${service.host.port}`,
          `connect=tcp:127.0.0.1:${service.guestPort!}`,
          "bind=host",
        ],
      }]
      : [];
    if (service.tailscaleServe) {
      commands.push({
        executable: service.tailscaleServe.executable,
        args: [
          "serve",
          "--bg",
          `--https=${service.tailscaleServe.httpsPort}`,
          exposureTarget(environment, service),
        ],
      });
    }
    return commands;
  });
}

function exposureTarget(
  environment: ResolvedAgentEnvironment,
  service: NonNullable<AgentEnvironmentConfig["exposure"]>["services"][number],
): string {
  if (service.upstream) return service.upstream;
  if (service.host) return `http://${service.host.address}:${service.host.port}`;
  const address = environment.config.backend.network.address;
  if (!address) throw new Error(`Direct exposure ${service.name} requires a guest network address`);
  return `http://${address}:${service.guestPort!}`;
}

interface TailscaleServeStatus {
  TCP?: Record<string, unknown>;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
}

export function tailscaleServeNeedsApply(
  status: TailscaleServeStatus,
  dnsName: string,
  httpsPort: number,
  desiredProxy: string,
): boolean {
  const port = String(httpsPort);
  const webKey = `${dnsName.replace(/\.$/, "")}:${port}`;
  const existingProxy = status.Web?.[webKey]?.Handlers?.["/"]?.Proxy;
  if ((status.TCP?.[port] || status.Web?.[webKey]) && existingProxy !== desiredProxy) {
    throw new Error(
      `Tailscale HTTPS port ${port} is already owned by ${existingProxy ?? "another handler"}`,
    );
  }
  return existingProxy !== desiredProxy;
}

export function buildHostServiceCommands(
  environment: ResolvedAgentEnvironment,
  refresh = false,
): CommandSpec[] {
  const systemctl = "/usr/bin/systemctl";
  const services = environment.config.hostServices ?? [];
  if (services.length === 0) return [];
  const commands: CommandSpec[] = services.map((service) => ({
    executable: systemctl,
    args: ["--user", "link", "--force", service.source],
  }));
  commands.push({ executable: systemctl, args: ["--user", "daemon-reload"] });
  for (const service of services) {
    const unit = basename(service.source);
    commands.push({
      executable: systemctl,
      args: ["--user", service.enabled ? "enable" : "disable", unit],
    });
  }
  // `systemctl disable` also removes links created by `systemctl link`. Restore
  // the discovery link for dormant units without adding a boot target wants link.
  for (const service of services) {
    if (!service.enabled) {
      commands.push({
        executable: systemctl,
        args: ["--user", "link", "--force", service.source],
      });
    }
  }
  if (services.some((service) => !service.enabled)) {
    commands.push({ executable: systemctl, args: ["--user", "daemon-reload"] });
  }
  for (const service of services) {
    const unit = basename(service.source);
    commands.push({
      executable: systemctl,
      args: [
        "--user",
        service.running ? (refresh && service.restartOnRefresh ? "restart" : "start") : "stop",
        unit,
      ],
    });
  }
  return commands;
}

export function isSupportedHostUnit(unit: string): boolean {
  return unit.endsWith(".service") || unit.endsWith(".socket") || unit.endsWith(".target");
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

async function outputText(command: CommandSpec): Promise<string> {
  const output = await run(command, false);
  return new TextDecoder().decode(output.stdout).trim();
}

async function runWithInput(command: CommandSpec, input: Uint8Array): Promise<void> {
  const child = new Deno.Command(command.executable, {
    args: command.args,
    stdin: "piped",
    stdout: "null",
    stderr: "inherit",
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(input);
  await writer.close();
  const status = await child.status;
  if (!status.success) {
    throw new Error(`Command failed (${status.code}): ${formatCommand(command)}`);
  }
}

function guestUserArgs(environment: ResolvedAgentEnvironment, command: string[]): string[] {
  const { backend, guest } = environment.config;
  return [
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
    "--env",
    `XDG_RUNTIME_DIR=/run/user/${guest.uid}`,
    "--env",
    `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${guest.uid}/bus`,
    "--",
    ...command,
  ];
}

function guestUserCommand(
  environment: ResolvedAgentEnvironment,
  command: string[],
): CommandSpec {
  return {
    executable: environment.config.backend.executable,
    args: guestUserArgs(environment, command),
  };
}

async function writeGuestFile(
  environment: ResolvedAgentEnvironment,
  path: string,
  content: string,
  asGuest = false,
): Promise<void> {
  const command = asGuest ? guestUserCommand(environment, ["tee", path]) : {
    executable: environment.config.backend.executable,
    args: ["exec", environment.config.backend.instance, "--", "tee", path],
  };
  await runWithInput(command, new TextEncoder().encode(content));
}

async function waitForGuestNetwork(environment: ResolvedAgentEnvironment): Promise<void> {
  const { backend } = environment.config;
  const deadline = performance.now() + 60_000;
  while (performance.now() < deadline) {
    if (
      await succeeds({
        executable: backend.executable,
        args: ["exec", backend.instance, "--", "getent", "hosts", "mirrors.kernel.org"],
      })
    ) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Guest network did not become ready in ${backend.instance}`);
}

async function validateEnvironment(
  environment: ResolvedAgentEnvironment,
  requireSecrets = true,
): Promise<void> {
  const { backend, guest, seeds } = environment.config;
  await assertFile(backend.executable, "Incus client", true);
  if (!/^[a-z_][a-z0-9_-]*$/.test(guest.user)) {
    throw new Error(`Unsafe guest user name: ${guest.user}`);
  }
  if (!guest.home.startsWith("/") || !guest.workspace.startsWith("/")) {
    throw new Error("Guest home and workspace must be absolute paths");
  }
  if (resolve(guest.home) !== guest.home || resolve(guest.workspace) !== guest.workspace) {
    throw new Error("Guest home and workspace must be normalized paths");
  }
  if (
    backend.network.address &&
    !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(backend.network.address)
  ) {
    throw new Error(`Guest network address must be IPv4: ${backend.network.address}`);
  }
  for (const seed of seeds) {
    if (basename(seed.source) === ".env") {
      throw new Error(`Secret files cannot be ordinary seeds: ${seed.source}`);
    }
    if (!seed.target.startsWith("/")) {
      throw new Error(`Seed target must be absolute: ${seed.target}`);
    }
    const source = await Deno.lstat(seed.source).catch(() => undefined);
    if (!source) throw new Error(`Seed source not found: ${seed.source}`);
    if (basename(seed.source) !== basename(seed.target)) {
      throw new Error(
        `Seed source and target basenames must match: ${seed.source} -> ${seed.target}`,
      );
    }
  }
  for (const npmPackage of guest.npmPackages ?? []) {
    if (!npmPackage.source) continue;
    const source = await Deno.lstat(npmPackage.source).catch(() => undefined);
    if (!source?.isFile) {
      throw new Error(`Local npm package artifact not found: ${npmPackage.source}`);
    }
  }
  const serviceNames = new Set<string>();
  for (const service of environment.config.hostServices ?? []) {
    const source = await Deno.lstat(service.source).catch(() => undefined);
    if (!source?.isFile) throw new Error(`Host service unit not found: ${service.source}`);
    const unit = basename(service.source);
    if (!isSupportedHostUnit(unit)) {
      throw new Error(
        `Host service source must end in .service, .socket, or .target: ${service.source}`,
      );
    }
    if (serviceNames.has(unit)) throw new Error(`Duplicate host service unit: ${unit}`);
    serviceNames.add(unit);
  }
  const mountNames = new Set<string>();
  for (const mount of environment.config.readOnlyMounts ?? []) {
    if (!mount.source.startsWith("/") || resolve(mount.source) !== mount.source) {
      throw new Error(
        `Read-only mount source must be an absolute normalized path: ${mount.source}`,
      );
    }
    if (!mount.target.startsWith("/") || resolve(mount.target) !== mount.target) {
      throw new Error(
        `Read-only mount target must be an absolute normalized path: ${mount.target}`,
      );
    }
    const source = await Deno.lstat(mount.source).catch(() => undefined);
    if (!source?.isDirectory && !source?.isFile) {
      throw new Error(`Read-only mount source not found: ${mount.source}`);
    }
    if (mountNames.has(mount.name)) throw new Error(`Duplicate read-only mount: ${mount.name}`);
    mountNames.add(mount.name);
  }
  const harness = environment.config.harness;
  if (harness?.kind === "turn-loop" && harness.phases) {
    if (harness.adapter !== "app-server") {
      throw new Error("Phased harnesses currently require adapter=app-server");
    }
    const names = harness.phases.map((phase) => phase.name);
    if (new Set(names).size !== names.length) throw new Error("Attempt phase names must be unique");
    for (const phase of harness.phases) {
      if (!phase.prompt.startsWith("/")) {
        throw new Error(`Attempt phase prompt must be absolute: ${phase.prompt}`);
      }
      if (phase.wrapUpSeconds >= phase.timeoutSeconds) {
        throw new Error(`Attempt phase ${phase.name} wrap-up must precede its timeout`);
      }
      for (const path of phase.requiredChangedFiles) {
        if (!path.startsWith("/")) {
          throw new Error(`Attempt phase required file must be absolute: ${path}`);
        }
      }
    }
    if (harness.phaseControl) {
      if (!harness.phaseControl.requestPath.startsWith("/")) {
        throw new Error("Attempt phase-control requestPath must be absolute");
      }
      if (!names.includes(harness.phaseControl.finalPhase)) {
        throw new Error(`Unknown harness final phase: ${harness.phaseControl.finalPhase}`);
      }
    }
  } else if (harness?.kind === "turn-loop" && harness.phaseControl) {
    throw new Error("Attempt phaseControl requires phases");
  }
  if (harness?.kind === "service") {
    for (const command of [harness.command, harness.ready.command]) {
      if (!command[0].startsWith("/")) {
        throw new Error(`Service command executable must be absolute: ${command[0]}`);
      }
    }
    const environmentInputKeys = new Set<string>();
    for (const input of harness.environmentInputs ?? []) {
      if (
        environmentInputKeys.has(input.key) || Object.hasOwn(harness.environment ?? {}, input.key)
      ) {
        throw new Error(`Duplicate service environment key: ${input.key}`);
      }
      environmentInputKeys.add(input.key);
    }
    const secretTargets = new Set<string>();
    for (const input of harness.secretInputs ?? []) {
      if (!input.target.startsWith("/")) {
        throw new Error(`Secret input target must be absolute: ${input.target}`);
      }
      if (resolve(input.target) !== input.target) {
        throw new Error(`Secret input target must be normalized: ${input.target}`);
      }
      if (!input.target.startsWith(`${guest.home}/`)) {
        throw new Error(`Secret input target must be beneath guest home: ${input.target}`);
      }
      if (input.target === guest.workspace || input.target.startsWith(`${guest.workspace}/`)) {
        throw new Error(
          `Secret input target must stay outside the agent workspace: ${input.target}`,
        );
      }
      if (secretTargets.has(input.target)) {
        throw new Error(`Duplicate secret input target: ${input.target}`);
      }
      secretTargets.add(input.target);
    }
    if (requireSecrets) {
      await readServiceInputs(harness, environment.config.hostServices);
    }
    const setupNames = new Set<string>();
    for (const step of harness.setup ?? []) {
      if (setupNames.has(step.name)) throw new Error(`Duplicate service setup step: ${step.name}`);
      setupNames.add(step.name);
      for (const command of [step.check, step.command]) {
        if (!command[0].startsWith("/")) {
          throw new Error(`Service setup executable must be absolute: ${command[0]}`);
        }
      }
    }
  }
  const exposureNames = new Set<string>();
  const hostPorts = new Set<number>();
  const tailscalePorts = new Set<number>();
  for (const service of environment.config.exposure?.services ?? []) {
    if (exposureNames.has(service.name)) {
      throw new Error(`Duplicate exposure name: ${service.name}`);
    }
    exposureNames.add(service.name);
    if ((service.guestPort === undefined) === (service.upstream === undefined)) {
      throw new Error(`Exposure ${service.name} requires exactly one of guestPort or upstream`);
    }
    if (service.host) {
      if (service.upstream) {
        throw new Error(`Exposure ${service.name} cannot combine host proxy and upstream`);
      }
      if (hostPorts.has(service.host.port)) {
        throw new Error(`Duplicate exposure host port: ${service.host.port}`);
      }
      hostPorts.add(service.host.port);
    } else if (service.upstream) {
      if (!service.tailscaleServe) {
        throw new Error(`Direct upstream exposure ${service.name} requires Tailscale Serve`);
      }
    } else if (!backend.network.address || !service.tailscaleServe) {
      throw new Error(
        `Exposure ${service.name} without a host proxy requires a static guest address and Tailscale Serve`,
      );
    }
    if (service.tailscaleServe) {
      await assertFile(service.tailscaleServe.executable, "Tailscale executable", true);
      if (tailscalePorts.has(service.tailscaleServe.httpsPort)) {
        throw new Error(`Duplicate Tailscale HTTPS port: ${service.tailscaleServe.httpsPort}`);
      }
      tailscalePorts.add(service.tailscaleServe.httpsPort);
    }
  }
  modelEndpoint(environment);
}

export function assertInstanceMayBeCreated(
  environment: ResolvedAgentEnvironment,
  exists: boolean,
): void {
  if (!exists && environment.config.backend.lifecycle?.createIfMissing === false) {
    throw new Error(
      `Persistent Incus instance ${environment.config.backend.instance} is missing; refusing to create a blank replacement`,
    );
  }
}

async function applyEnvironment(environment: ResolvedAgentEnvironment): Promise<void> {
  const { backend, guest } = environment.config;
  const incus = backend.executable;
  await run({ executable: incus, args: ["network", "show", backend.network.name] }, false);
  const exists = await succeeds({ executable: incus, args: ["config", "show", backend.instance] });
  assertInstanceMayBeCreated(environment, exists);
  const created = !exists;
  if (!exists) {
    console.log(`Creating Incus instance ${backend.instance} from ${backend.image}`);
    await run({ executable: incus, args: ["init", backend.image, backend.instance] });
  }
  await run(buildApplyPlan(environment)[2]);
  if (backend.network.address) {
    // An instance-level override already exists on a reconciled instance; overriding
    // it a second time is an error, so update the existing device instead.
    const deviceExists = await succeeds({
      executable: incus,
      args: ["config", "device", "get", backend.instance, backend.network.device, "ipv4.address"],
    });
    await run(buildNetworkAddressCommand(environment, deviceExists)!);
  }
  await reconcileReadOnlyMounts(environment);

  const running = await succeeds({
    executable: incus,
    args: ["exec", backend.instance, "--", "true"],
  });
  if (!running) await run({ executable: incus, args: ["start", backend.instance] });
  const packagesReady = await succeeds({
    executable: incus,
    args: ["exec", backend.instance, "--", "pacman", "-T", ...guest.packages],
  });
  if (!packagesReady) {
    await waitForGuestNetwork(environment);
    await provisionEnvironment(environment);
  }

  await ensureGuestUser(environment);
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
  await reconcileGuestAdministration(environment);
  await provisionNpmPackages(environment);
  if (environment.config.seedOnCreate) {
    await seedEnvironment(environment, false, !created);
  }
  await reconcileHostServices(environment);
  await reconcileServiceHarness(environment);
  await reconcileExposure(environment);
  console.log(`Ready agent environment: ${environment.config.name} (${backend.instance})`);
}

async function reconcileReadOnlyMounts(environment: ResolvedAgentEnvironment): Promise<void> {
  const { backend } = environment.config;
  for (const mount of environment.config.readOnlyMounts ?? []) {
    const type = await outputText({
      executable: backend.executable,
      args: ["config", "device", "get", backend.instance, mount.name, "type"],
    }).catch(() => "");
    if (!type) {
      await run(buildReadOnlyMountAddCommand(environment, mount));
      continue;
    }
    if (type !== "disk") {
      throw new Error(`Incus device ${mount.name} is ${type}, expected disk`);
    }
    for (
      const [key, desired] of Object.entries({
        source: mount.source,
        path: mount.target,
        readonly: "true",
      })
    ) {
      const actual = await outputText({
        executable: backend.executable,
        args: ["config", "device", "get", backend.instance, mount.name, key],
      });
      if (actual !== desired) {
        await run({
          executable: backend.executable,
          args: ["config", "device", "set", backend.instance, mount.name, `${key}=${desired}`],
        });
      }
    }
  }
}

async function ensureGuestUser(environment: ResolvedAgentEnvironment): Promise<void> {
  const { backend, guest } = environment.config;
  const incus = backend.executable;
  const passwd = await outputText({
    executable: incus,
    args: ["exec", backend.instance, "--", "getent", "passwd", String(guest.uid)],
  }).catch(() => "");
  if (passwd) {
    const [name, , uid, gid, , home] = passwd.split(":");
    if (
      name !== guest.user || uid !== String(guest.uid) || gid !== String(guest.gid) ||
      home !== guest.home
    ) {
      throw new Error(`Guest uid ${guest.uid} already belongs to incompatible account: ${passwd}`);
    }
    return;
  }
  const namedUser = await succeeds({
    executable: incus,
    args: ["exec", backend.instance, "--", "getent", "passwd", guest.user],
  });
  if (namedUser) throw new Error(`Guest user ${guest.user} already exists with another uid`);
  const group = await outputText({
    executable: incus,
    args: ["exec", backend.instance, "--", "getent", "group", String(guest.gid)],
  }).catch(() => "");
  if (group && group.split(":", 1)[0] !== guest.user) {
    throw new Error(`Guest gid ${guest.gid} already belongs to incompatible group: ${group}`);
  }
  if (!group) {
    await run({
      executable: incus,
      args: ["exec", backend.instance, "--", "groupadd", "--gid", String(guest.gid), guest.user],
    });
  }
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

async function reconcileGuestAdministration(
  environment: ResolvedAgentEnvironment,
): Promise<void> {
  const { guest } = environment.config;
  const administration = guest.administration;
  if (!administration) return;
  if (administration.passwordlessSudo) {
    const sudoers = `/etc/sudoers.d/90-lm-tools-${guest.user}`;
    await writeGuestFile(
      environment,
      sudoers,
      `${guest.user} ALL=(ALL:ALL) NOPASSWD: ALL\n`,
    );
  }
  for (const command of buildGuestAdministrationCommands(environment)) await run(command, false);
}

async function provisionNpmPackages(environment: ResolvedAgentEnvironment): Promise<void> {
  for (const npmPackage of environment.config.guest.npmPackages ?? []) {
    const reference = `${npmPackage.name}@${npmPackage.version}`;
    if (npmPackage.integrity) {
      await verifyRegistryIntegrity(environment, {
        name: npmPackage.name,
        version: npmPackage.version,
        integrity: npmPackage.integrity,
      });
    }
    const installedText = await outputText({
      executable: environment.config.backend.executable,
      args: [
        "exec",
        environment.config.backend.instance,
        "--",
        "npm",
        "list",
        "--global",
        "--depth=0",
        "--json",
      ],
    }).catch(() => "{}");
    const installed = JSON.parse(installedText) as {
      dependencies?: Record<string, { version?: string }>;
    };
    if (
      !npmPackage.source &&
      installed.dependencies?.[npmPackage.name]?.version === npmPackage.version
    ) continue;
    if (npmPackage.source) {
      const targetDirectory = "/var/cache/lm-tools/npm";
      await run({
        executable: environment.config.backend.executable,
        args: [
          "exec",
          environment.config.backend.instance,
          "--",
          "mkdir",
          "-p",
          targetDirectory,
        ],
      }, false);
      await run({
        executable: environment.config.backend.executable,
        args: [
          "file",
          "push",
          npmPackage.source,
          `${environment.config.backend.instance}${targetDirectory}/${basename(npmPackage.source)}`,
        ],
      }, false);
    }
    console.log(`Installing pinned npm package ${reference}`);
    await run(buildNpmInstallCommand(environment, npmPackage));
    if (
      !(await succeeds({
        executable: environment.config.backend.executable,
        args: [
          "exec",
          environment.config.backend.instance,
          "--",
          "npm",
          "list",
          "--global",
          "--depth=0",
          reference,
        ],
      }))
    ) {
      throw new Error(`Pinned npm package did not verify after installation: ${reference}`);
    }
  }
}

async function verifyRegistryIntegrity(
  environment: ResolvedAgentEnvironment,
  pin: { name?: string; package?: string; version: string; integrity: string },
  asGuest = false,
): Promise<void> {
  const packageName = pin.name ?? pin.package!;
  const reference = `${packageName}@${pin.version}`;
  const argv = ["npm", "view", reference, "dist.integrity", "--json"];
  const integrityText = await outputText(
    asGuest ? guestUserCommand(environment, argv) : {
      executable: environment.config.backend.executable,
      args: ["exec", environment.config.backend.instance, "--", ...argv],
    },
  );
  const response = JSON.parse(integrityText) as unknown;
  const integrity = npmRegistryIntegrity(response);
  if (integrity !== pin.integrity) {
    throw new Error(
      `npm integrity mismatch for ${reference}: expected ${pin.integrity}, got ${
        JSON.stringify(response)
      }`,
    );
  }
}

export function npmRegistryIntegrity(response: unknown): string | undefined {
  if (typeof response === "string") return response;
  if (Array.isArray(response) && response.length === 1 && typeof response[0] === "string") {
    return response[0];
  }
  return undefined;
}

function jsonPointer(value: unknown, pointer: string): unknown {
  return pointer.slice(1).split("/").reduce<unknown>((current, segment) => {
    if (typeof current !== "object" || current === null) return undefined;
    const key = segment.replaceAll("~1", "/").replaceAll("~0", "~");
    return (current as Record<string, unknown>)[key];
  }, value);
}

async function serviceSetupReady(
  environment: ResolvedAgentEnvironment,
  step: NonNullable<ServiceHarness["setup"]>[number],
  serviceEnvironment: Record<string, string> = {},
): Promise<boolean> {
  const command = guestServiceCommand(environment, serviceEnvironment, step.check);
  if (!step.checkJson) return await succeeds(command);
  try {
    const value = JSON.parse(await outputText(command));
    return step.checkJson.every((expectation) =>
      Object.is(jsonPointer(value, expectation.pointer), expectation.equals)
    );
  } catch {
    return false;
  }
}

export function buildServiceUnit(
  environment: ResolvedAgentEnvironment,
  harness: ServiceHarness,
  inputEnvironment: Record<string, string> = {},
): string {
  const systemdQuote = (value: string) => JSON.stringify(value.replaceAll("%", "%%"));
  const environmentLines = Object.entries({ ...harness.environment, ...inputEnvironment }).map((
    [key, value],
  ) => `Environment=${systemdQuote(`${key}=${value}`)}`);
  return [
    "[Unit]",
    `Description=lm-tools service harness for ${environment.config.name}`,
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${environment.config.guest.workspace}`,
    `ExecStart=${harness.command.map(systemdQuote).join(" ")}`,
    ...environmentLines,
    `Restart=${harness.restart}`,
    `RestartSec=${harness.restartSeconds}`,
    `RestartPreventExitStatus=${harness.restartPreventExitStatuses.join(" ")}`,
    "KillMode=control-group",
    "OOMPolicy=continue",
    "TimeoutStartSec=120",
    "TimeoutStopSec=30",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

function guestServiceCommand(
  environment: ResolvedAgentEnvironment,
  serviceEnvironment: Record<string, string>,
  command: string[],
): CommandSpec {
  return guestUserCommand(environment, [
    "/usr/bin/env",
    ...Object.entries(serviceEnvironment).map(([key, value]) => `${key}=${value}`),
    ...command,
  ]);
}

async function importServiceSecrets(
  environment: ResolvedAgentEnvironment,
  harness: ServiceHarness,
  sourceValues: Map<string, Record<string, string>>,
): Promise<void> {
  for (const input of harness.secretInputs ?? []) {
    const value = sourceValues.get(input.source)?.[input.key];
    if (value === undefined) throw new Error(`Missing protected service input ${input.key}`);
    console.log(`Importing protected secret ${input.key}: present`);
    const targetDirectory = dirname(input.target);
    await run(guestUserCommand(environment, ["mkdir", "-p", targetDirectory]), false);
    await run(guestUserCommand(environment, ["chmod", "0700", targetDirectory]), false);
    const temporary = `${input.target}.lm-tools-${crypto.randomUUID()}`;
    try {
      await runWithInput(
        guestUserCommand(environment, ["tee", temporary]),
        new TextEncoder().encode(value),
      );
      await run(guestUserCommand(environment, ["chmod", "0600", temporary]), false);
      await run(guestUserCommand(environment, ["mv", "--", temporary, input.target]), false);
    } catch (error) {
      await run(guestUserCommand(environment, ["rm", "-f", "--", temporary]), false).catch(() =>
        undefined
      );
      throw error;
    }
  }
}

async function reconcileServiceHarness(
  environment: ResolvedAgentEnvironment,
  refresh = false,
): Promise<void> {
  const harness = environment.config.harness;
  if (!harness || harness.kind !== "service") return;
  const { guest } = environment.config;
  await run(
    guestUserCommand(environment, ["mkdir", "-p", `${guest.home}/.config/systemd/user`]),
    false,
  );
  const inputValues = await readServiceInputs(harness, environment.config.hostServices);
  const inputEnvironment = {
    ...harness.environment,
    ...serviceEnvironmentInputs(harness, inputValues),
  };
  await importServiceSecrets(environment, harness, inputValues);
  for (const step of harness.setup ?? []) {
    if (step.registryIntegrity) {
      await verifyRegistryIntegrity(environment, step.registryIntegrity, true);
    }
    if (await serviceSetupReady(environment, step, inputEnvironment)) continue;
    console.log(`Running service setup: ${step.name}`);
    await run(guestServiceCommand(environment, inputEnvironment, step.command));
    if (!(await serviceSetupReady(environment, step, inputEnvironment))) {
      throw new Error(`Service setup check still fails after ${step.name}`);
    }
  }
  const unitPath = `${guest.home}/.config/systemd/user/${harness.unit}`;
  await writeGuestFile(
    environment,
    unitPath,
    buildServiceUnit(environment, harness, inputEnvironment),
    true,
  );
  await run(guestUserCommand(environment, ["systemctl", "--user", "daemon-reload"]), false);
  await run(
    guestUserCommand(environment, [
      "systemctl",
      "--user",
      "enable",
      "--now",
      harness.unit,
    ]),
    false,
  );
  if (refresh && harness.restartOnRefresh) {
    await run(
      guestUserCommand(environment, ["systemctl", "--user", "restart", harness.unit]),
      false,
    );
  }
  const deadline = performance.now() + harness.ready.timeoutSeconds * 1000;
  while (performance.now() < deadline) {
    if (await succeeds(guestServiceCommand(environment, inputEnvironment, harness.ready.command))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Service harness ${harness.unit} did not become ready`);
}

async function reconcileExposure(environment: ResolvedAgentEnvironment): Promise<void> {
  const { backend } = environment.config;
  for (const service of environment.config.exposure?.services ?? []) {
    if (service.host) {
      const desired = {
        type: "proxy",
        listen: `tcp:${service.host.address}:${service.host.port}`,
        connect: `tcp:127.0.0.1:${service.guestPort!}`,
        bind: "host",
      };
      const deviceExists = await succeeds({
        executable: backend.executable,
        args: ["config", "device", "get", backend.instance, service.name, "type"],
      });
      if (!deviceExists) {
        await run(
          buildExposureCommands(environment).find((command) =>
            command.executable === backend.executable && command.args.includes(service.name)
          )!,
        );
      } else {
        for (const [key, value] of Object.entries(desired)) {
          const actual = await outputText({
            executable: backend.executable,
            args: ["config", "device", "get", backend.instance, service.name, key],
          });
          if (actual !== value) {
            throw new Error(
              `Incus device ${service.name} ${key} is ${JSON.stringify(actual)}, expected ${
                JSON.stringify(value)
              }`,
            );
          }
        }
      }
    }
    const tailscale = service.tailscaleServe;
    if (!tailscale) continue;
    const statusText = await outputText({
      executable: tailscale.executable,
      args: ["serve", "status", "--json"],
    });
    const status = JSON.parse(statusText) as TailscaleServeStatus;
    const tailscaleStatus = JSON.parse(
      await outputText({
        executable: tailscale.executable,
        args: ["status", "--json"],
      }),
    ) as { Self?: { DNSName?: string } };
    const dnsName = tailscaleStatus.Self?.DNSName?.replace(/\.$/, "");
    if (!dnsName) throw new Error("Could not resolve this host's Tailscale DNS name");
    const port = String(tailscale.httpsPort);
    const webKey = `${dnsName}:${port}`;
    const desiredProxy = exposureTarget(environment, service);
    if (tailscaleServeNeedsApply(status, dnsName, tailscale.httpsPort, desiredProxy)) {
      await run({
        executable: tailscale.executable,
        args: ["serve", "--bg", `--https=${port}`, desiredProxy],
      });
    }
    console.log(`Tailscale Serve: https://${webKey}/ -> ${desiredProxy}`);
  }
}

async function stopServiceHarness(environment: ResolvedAgentEnvironment): Promise<void> {
  const harness = environment.config.harness;
  if (!harness || harness.kind !== "service") {
    throw new Error("This action requires a service harness");
  }
  await run(guestUserCommand(environment, ["systemctl", "--user", "stop", harness.unit]), false);
  for (const service of environment.config.hostServices ?? []) {
    const unit = basename(service.source);
    if (unit.endsWith(".target")) {
      await run({ executable: "/usr/bin/systemctl", args: ["--user", "stop", unit] }, false);
    }
  }
  for (const service of environment.config.exposure?.services ?? []) {
    const tailscale = service.tailscaleServe;
    if (!tailscale) continue;
    await run({
      executable: tailscale.executable,
      args: ["serve", `--https=${tailscale.httpsPort}`, "off"],
    });
  }
}

async function reconcileHostServices(
  environment: ResolvedAgentEnvironment,
  refresh = false,
): Promise<void> {
  for (const command of buildHostServiceCommands(environment, refresh)) await run(command, false);
}

async function provisionEnvironment(environment: ResolvedAgentEnvironment): Promise<void> {
  console.log(`Provisioning guest packages in ${environment.config.backend.instance}`);
  await run(buildProvisionCommand(environment));
}

async function serveModelProxy(environment: ResolvedAgentEnvironment): Promise<void> {
  const model = environment.model;
  if (!model) throw new Error("The model proxy requires a declared model deployment");
  const modelBackend = model.config.backend;
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
    "--context-limit",
    String(model.config.runtime.contextWindow),
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
  const archivePlan = buildSeedArchive(seed);
  console.log(
    `  selection: ${archivePlan.mode === "git" ? "git --exclude-standard" : "recursive"}`,
  );
  const archive = new Deno.Command(archivePlan.command.executable, {
    args: archivePlan.command.args,
    stdin: archivePlan.stdin ? "piped" : "null",
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
  const input = archivePlan.stdin
    ? (async () => {
      const writer = archive.stdin.getWriter();
      await writer.write(archivePlan.stdin!);
      await writer.close();
    })()
    : Promise.resolve();
  const pipe = archive.stdout.pipeTo(extract.stdin);
  const [archiveStatus, extractStatus] = await Promise.all([
    archive.status,
    extract.status,
    input,
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
  if (seed.mode) {
    await run({
      executable: backend.executable,
      args: ["exec", backend.instance, "--", "chmod", seed.mode, seed.target],
    });
  }
}

async function seedEnvironment(
  environment: ResolvedAgentEnvironment,
  refreshOnly = false,
  missingOnly = false,
  force = false,
): Promise<void> {
  for (const seed of environment.config.seeds) {
    if (!force && seed.policy === "manual") continue;
    if (!force && refreshOnly && seed.policy !== "refresh") continue;
    const targetExists = await succeeds({
      executable: environment.config.backend.executable,
      args: ["exec", environment.config.backend.instance, "--", "test", "-e", seed.target],
    });
    if (!force && (missingOnly || seed.policy === "create") && targetExists) {
      if (seed.mode) {
        await run({
          executable: environment.config.backend.executable,
          args: [
            "exec",
            environment.config.backend.instance,
            "--",
            "chmod",
            seed.mode,
            seed.target,
          ],
        });
      }
      continue;
    }
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
  const harness = environment.config.harness;
  if (harness?.kind === "service") {
    const state = await outputText(
      guestUserCommand(environment, ["systemctl", "--user", "is-active", harness.unit]),
    ).catch(() => "inactive");
    console.log(`Guest service ${harness.unit}: ${state}`);
    for (const service of environment.config.exposure?.services ?? []) {
      if (service.tailscaleServe) {
        await run({
          executable: service.tailscaleServe.executable,
          args: ["serve", "status"],
        });
        break;
      }
    }
  }
}

async function showAttemptMetrics(environment: ResolvedAgentEnvironment): Promise<void> {
  const harness = environment.config.harness;
  if (!harness || harness.kind !== "turn-loop") {
    throw new Error("Attempt metrics require a turn-loop harness");
  }
  const path = `${harness.metricsDirectory}/campaign.json`;
  try {
    console.log(await Deno.readTextFile(path));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      console.log(`No harness campaign has been recorded yet: ${path}`);
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
  let path: string | undefined;
  let action:
    | "check"
    | "dry-run"
    | "apply"
    | "provision"
    | "seed"
    | "force-seed"
    | "refresh"
    | "model-proxy"
    | "attempt-once"
    | "attempt-loop"
    | "attempt-metrics"
    | "attempt-dashboard"
    | "service-start"
    | "service-restart"
    | "service-stop"
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
    else if (arg === "--force-seed") setAction("force-seed");
    else if (arg === "--refresh") setAction("refresh");
    else if (arg === "--model-proxy") setAction("model-proxy");
    else if (arg === "--attempt-once") setAction("attempt-once");
    else if (arg === "--attempt-loop") setAction("attempt-loop");
    else if (arg === "--attempt-metrics") setAction("attempt-metrics");
    else if (arg === "--attempt-dashboard") setAction("attempt-dashboard");
    else if (arg === "--service-start") setAction("service-start");
    else if (arg === "--service-restart") setAction("service-restart");
    else if (arg === "--service-stop") setAction("service-stop");
    else if (arg === "--status") setAction("status");
    else if (arg === "--exec") setAction("exec");
    else if (arg.startsWith("-")) throw new Error(`Unknown env option: ${arg}`);
    else if (path !== undefined) {
      throw new Error("Only one environment CONFIG is accepted");
    } else path = arg;
  }
  if (!action) throw new Error(`An action is required\n\n${environmentUsage()}`);
  if (!path) throw new Error(`An environment CONFIG is required\n\n${environmentUsage()}`);
  if (action !== "exec" && execArgs.length > 0) {
    throw new Error("Command argv is only valid with --exec");
  }

  const environment = await loadAgentEnvironment(path);
  await runEnvironmentAction(environment, action, execArgs);
}

export async function runEnvironmentAction(
  environment: ResolvedAgentEnvironment,
  action:
    | "check"
    | "dry-run"
    | "apply"
    | "provision"
    | "seed"
    | "force-seed"
    | "refresh"
    | "model-proxy"
    | "attempt-once"
    | "attempt-loop"
    | "attempt-metrics"
    | "attempt-dashboard"
    | "service-start"
    | "service-restart"
    | "service-stop"
    | "status"
    | "exec",
  execArgs: string[] = [],
): Promise<void> {
  await validateEnvironment(
    environment,
    ["check", "apply", "refresh", "service-start", "service-restart"].includes(action),
  );
  if (action === "check") {
    console.log(`Valid agent environment: ${environment.config.name} (${environment.sourcePath})`);
  } else if (action === "dry-run") {
    console.log(`Environment: ${environment.config.name}`);
    console.log(`Instance:    ${environment.config.backend.instance}`);
    console.log(
      `Model:       ${environment.model?.config.name ?? "(none — remote inference only)"}`,
    );
    console.log(
      `Model API:   http://${environment.config.backend.modelAccess.host}:${environment.config.backend.modelAccess.port}/v1`,
    );
    for (const command of buildApplyPlan(environment)) console.log(formatCommand(command));
    console.log(formatCommand(buildProvisionCommand(environment)));
    console.log("if guest account is absent:");
    for (const command of buildGuestUserCommands(environment)) console.log(formatCommand(command));
    if (environment.config.guest.administration?.passwordlessSudo) {
      console.log(`write /etc/sudoers.d/90-lm-tools-${environment.config.guest.user} mode=0440`);
    }
    for (const command of buildGuestAdministrationCommands(environment)) {
      console.log(formatCommand(command));
    }
    for (const npmPackage of environment.config.guest.npmPackages ?? []) {
      console.log(
        `verify npm integrity ${npmPackage.name}@${npmPackage.version}: ${npmPackage.integrity}`,
      );
      console.log(formatCommand(buildNpmInstallCommand(environment, npmPackage)));
    }
    for (const seedCommands of buildSeedCommandGroups(environment)) {
      console.log(formatCommand(seedCommands[0]));
      console.log(
        `${formatCommand(seedCommands[1])} | ${formatCommand(seedCommands[2])}`,
      );
      for (const command of seedCommands.slice(3)) console.log(formatCommand(command));
    }
    for (const command of buildHostServiceCommands(environment)) {
      console.log(formatCommand(command));
    }
    const harness = environment.config.harness;
    if (harness?.kind === "service") {
      for (const input of harness.secretInputs ?? []) {
        console.log(`write guest secret file ${input.target} mode=0600 < [REDACTED:${input.key}]`);
      }
      for (const step of harness.setup ?? []) {
        if (step.registryIntegrity) {
          console.log(
            `verify npm integrity ${step.registryIntegrity.package}@${step.registryIntegrity.version}: ${step.registryIntegrity.integrity}`,
          );
        }
        console.log(`if-not: ${formatCommand(guestUserCommand(environment, step.check))}`);
        for (const expectation of step.checkJson ?? []) {
          console.log(`  require ${expectation.pointer} = ${JSON.stringify(expectation.equals)}`);
        }
        console.log(formatCommand(guestUserCommand(environment, step.command)));
      }
      console.log(`write guest systemd user unit: ${harness.unit}`);
    }
    for (const command of buildExposureCommands(environment)) console.log(formatCommand(command));
  } else if (action === "apply") await applyEnvironment(environment);
  else if (action === "provision") {
    await provisionEnvironment(environment);
    await ensureGuestUser(environment);
    await reconcileGuestAdministration(environment);
    await provisionNpmPackages(environment);
  } else if (action === "seed") await seedEnvironment(environment);
  else if (action === "force-seed") await seedEnvironment(environment, false, false, true);
  else if (action === "refresh") {
    await seedEnvironment(environment, true);
    await reconcileReadOnlyMounts(environment);
    await reconcileHostServices(environment, true);
    await reconcileServiceHarness(environment, true);
    await reconcileExposure(environment);
  } else if (action === "model-proxy") await serveModelProxy(environment);
  else if (action === "attempt-once") {
    if (!environment.model) {
      throw new Error("Attempt actions require a declared model deployment");
    }
    const { run, ledger } = await runAttemptOnce(environment);
    console.log(
      `Attempt ${run.id}: exit=${run.exitCode}, ${run.durationSeconds.toFixed(1)}s, ` +
        `${run.usage.totalTokens.toLocaleString("en-US")} tokens`,
    );
    console.log(
      `Campaign: ${ledger.runs} runs, ${(ledger.wallSeconds / 3600).toFixed(2)} hours, ` +
        `${ledger.usage.totalTokens.toLocaleString("en-US")} tokens`,
    );
    if (run.finalMessage) console.log(run.finalMessage.trim());
    if (run.exitCode !== 0) throw new Error(`Attempt harness exited with status ${run.exitCode}`);
  } else if (action === "attempt-loop") await runAttemptLoop(environment);
  else if (action === "attempt-metrics") await showAttemptMetrics(environment);
  else if (action === "attempt-dashboard") await serveHarnessDashboard(environment);
  else if (action === "service-start") {
    await reconcileReadOnlyMounts(environment);
    await reconcileHostServices(environment);
    await reconcileServiceHarness(environment);
    await reconcileExposure(environment);
  } else if (action === "service-restart") {
    await reconcileReadOnlyMounts(environment);
    await reconcileHostServices(environment, true);
    await reconcileServiceHarness(environment, true);
    await reconcileExposure(environment);
  } else if (action === "service-stop") await stopServiceHarness(environment);
  else if (action === "status") await showStatus(environment);
  else await execEnvironment(environment, execArgs);
}
