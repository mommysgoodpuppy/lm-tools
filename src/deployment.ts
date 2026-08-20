import { Ajv2020, type ErrorObject } from "npm:ajv@8.17.1/dist/2020.js";
import { dirname, resolve } from "jsr:@std/path@1";
import {
  assertFile,
  buildLlamaArgs,
  type LlamaOptions,
  runLlama,
  shellQuote,
  spawnLlama,
} from "./llama.ts";
import { downloadFile, recommendedConnections, verifyFileIntegrity } from "./download.ts";
import { defaultDiagnosticLog, type DiagnosticLog } from "./log.ts";
import {
  acquireExclusiveLease,
  evictConflictingProcesses,
  requireModelVram,
  terminateChild,
} from "./process_manager.ts";
import { runVscodeStack } from "./vscode.ts";

const PROJECT_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const DEPLOYMENT_SCHEMA = `${PROJECT_ROOT}/schemas/deployment.schema.json`;
const BASE_SCHEMA = `${PROJECT_ROOT}/schemas/base.schema.json`;
const BASE_CONFIG = `${PROJECT_ROOT}/config/base.json`;
const DEFAULT_DEPLOYMENT = `${PROJECT_ROOT}/deployments/qwen-vscode.json`;

type ReasoningEffort = "none" | "low" | "medium" | "high";
type ReasoningLevel = ReasoningEffort | "minimal" | "xhigh" | "max";
type ReasoningLevelMap = Record<ReasoningLevel, string | null>;

interface BaseConfig {
  clients: { reasoningLevels: { vscode: ReasoningLevelMap; pi: ReasoningLevelMap } };
  resources: ModelDeployment["resources"];
}

interface ModelDeployment {
  $schema?: string;
  version: 1;
  name: string;
  model: {
    id: string;
    name: string;
    path: string;
    source?: {
      url: string;
      size: number;
      sha256: string;
    };
    capabilities: {
      tools: boolean;
      vision: boolean;
      reasoning: boolean;
      streaming: boolean;
      supportedReasoningLevels?: string[];
      reasonLevelMap?: Record<string, ReasoningLevel>;
    };
  };
  runtime: {
    contextWindow: number;
    maxOutputTokens: number;
    expectedVramMiB?: number;
  };
  resources?: {
    gpu:
      | { mode: "shared" }
      | {
        mode: "exclusive";
        conflictingExecutables: string[];
        shutdownGraceSeconds: number;
        vram: { devicePath: string; minimumRemainingMiB: number };
      };
  };
  backend: LlamaCppBackend | LlamaCppDiffusionBackend;
  compatibility?: {
    responsesProxy: DisabledService | EnabledProxy;
  };
  exposure?: {
    tailscaleServe: DisabledService | TailscaleServe;
  };
  clients?: {
    vscode: DisabledService | VscodeClient;
  };
  services?: Array<ProcessService | DiffusionGemmaLabService>;
}

interface LlamaCppBackend {
  kind: "llama.cpp";
  executable: string;
  listen: ListenAddress;
  gpuLayers: "all" | number;
  flashAttention: boolean;
  kvCache: { key: string; value: string };
  batch: { logical: number; physical: number };
  parallel: number;
  ui: boolean;
  speculative: { kind: "none" } | { kind: "mtp"; draftTokens: number };
}

interface LlamaCppDiffusionBackend {
  kind: "llama.cpp-diffusion";
  executable: string;
  device: string;
  gpuLayers: "all" | number;
  flashAttention: "auto" | "on" | "off";
  fit: {
    enabled: boolean;
    marginMiB: number;
  };
}

interface ListenAddress {
  host: string;
  port: number;
}

interface DisabledService {
  enabled: false;
}

interface EnabledProxy {
  enabled: true;
  listen: ListenAddress;
}

interface TailscaleServe {
  enabled: true;
  executable: string;
  httpsPort: number;
}

interface VscodeClient {
  enabled: true;
  configPath: string;
  providerName: string;
  vendor: string;
  reasoningEffort: ReasoningEffort;
}

interface ProcessService {
  kind: "process";
  name: string;
  executable: string;
  args: string[];
  cwd: string;
  environment: Record<string, string>;
  ready: {
    url: string;
    timeoutSeconds: number;
  };
}

interface DiffusionGemmaLabService {
  kind: "diffusiongemma-lab";
  name: string;
  checkout: string;
  listen: ListenAddress;
  readyTimeoutSeconds: number;
}

interface ResolvedProcessService {
  name: string;
  executable: string;
  args: string[];
  cwd: string;
  environment: Record<string, string>;
  ready: {
    url: string;
    timeoutSeconds: number;
  };
}

type JsonObject = Record<string, unknown>;

export interface ResolvedDeployment {
  sourcePath: string;
  config: ModelDeployment;
  base: BaseConfig;
  llama?: LlamaOptions;
  proxy?: EnabledProxy;
  tailscaleServe?: TailscaleServe;
  vscode?: VscodeClient;
}

export function deployUsage(): string {
  return `Usage: lm deploy [CONFIG] [options]

Validate and run a complete local-model deployment. CONFIG defaults to:
  ${DEFAULT_DEPLOYMENT}

Options:
  --check        Validate the schema, files, and installed backend flags
  --dry-run      Print the resolved process and generated client configuration
  --fetch        Download or verify the declared model artifact, then exit
  --client-only  Reconcile declared client configuration without starting services
  --help         Show this help`;
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? []).map((error) => {
    const location = error.instancePath || "/";
    return `${location}: ${error.message ?? error.keyword}`;
  }).join("\n");
}

export async function loadDeployment(path: string): Promise<ResolvedDeployment> {
  const sourcePath = resolve(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await Deno.readTextFile(sourcePath));
  } catch (error) {
    throw new Error(
      `Could not read deployment ${sourcePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const schema = JSON.parse(await Deno.readTextFile(DEPLOYMENT_SCHEMA));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate = ajv.compile(schema);
  if (!validate(parsed)) {
    throw new Error(`Invalid deployment ${sourcePath}:\n${formatAjvErrors(validate.errors)}`);
  }

  const base = JSON.parse(await Deno.readTextFile(BASE_CONFIG));
  const baseSchema = JSON.parse(await Deno.readTextFile(BASE_SCHEMA));
  const validateBase = ajv.compile(baseSchema);
  if (!validateBase(base)) {
    throw new Error(
      `Invalid base configuration ${BASE_CONFIG}:\n${formatAjvErrors(validateBase.errors)}`,
    );
  }
  const baseConfig = base as BaseConfig;
  const config = parsed as ModelDeployment;
  config.resources ??= baseConfig.resources;
  const supportedReasoningLevels = config.model.capabilities.supportedReasoningLevels ?? [];
  for (const wireLevel of supportedReasoningLevels) {
    const canonical = config.model.capabilities.reasonLevelMap?.[wireLevel] ?? wireLevel;
    if (!Object.hasOwn(baseConfig.clients.reasoningLevels.pi, canonical)) {
      throw new Error(`Reasoning level ${wireLevel} needs a canonical reasonLevelMap entry`);
    }
  }
  for (const wireLevel of Object.keys(config.model.capabilities.reasonLevelMap ?? {})) {
    if (!supportedReasoningLevels.includes(wireLevel)) {
      throw new Error(`reasonLevelMap key ${wireLevel} is not in supportedReasoningLevels`);
    }
  }
  const backend = config.backend;
  const proxy = config.compatibility?.responsesProxy.enabled
    ? config.compatibility.responsesProxy
    : undefined;
  const tailscaleServe = config.exposure?.tailscaleServe.enabled
    ? config.exposure.tailscaleServe
    : undefined;
  const vscode = config.clients?.vscode.enabled ? config.clients.vscode : undefined;
  if (vscode && vscode.reasoningEffort !== "none" && !config.model.capabilities.reasoning) {
    throw new Error("VS Code reasoningEffort requires model.capabilities.reasoning=true");
  }
  if (
    vscode &&
    !config.model.capabilities.supportedReasoningLevels?.some((wireLevel) => {
      const canonical = config.model.capabilities.reasonLevelMap?.[wireLevel] ?? wireLevel;
      return baseConfig.clients.reasoningLevels.vscode[canonical as ReasoningLevel] ===
        vscode.reasoningEffort;
    })
  ) {
    throw new Error(
      `VS Code reasoningEffort ${vscode.reasoningEffort} is not available for this model`,
    );
  }
  if (backend.kind !== "llama.cpp" && (proxy || vscode || tailscaleServe)) {
    throw new Error(
      `${backend.kind} does not expose the HTTP API required by proxy/VS Code/Tailscale Serve`,
    );
  }
  const llama: LlamaOptions | undefined = backend.kind === "llama.cpp"
    ? {
      model: config.model.path,
      server: backend.executable,
      host: backend.listen.host,
      port: backend.listen.port,
      context: config.runtime.contextWindow,
      cacheTypeK: backend.kvCache.key,
      cacheTypeV: backend.kvCache.value,
      gpuLayers: String(backend.gpuLayers),
      flashAttention: backend.flashAttention,
      batchSize: backend.batch.logical,
      ubatchSize: backend.batch.physical,
      parallel: backend.parallel,
      mtpDraftTokens: backend.speculative.kind === "mtp" ? backend.speculative.draftTokens : 0,
      webui: backend.ui,
      dryRun: false,
      serverArgs: [],
    }
    : undefined;
  return { sourcePath, config, base: baseConfig, llama, proxy, tailscaleServe, vscode };
}

function clientReasoningLevelMap(
  deployment: ResolvedDeployment,
  client: "vscode" | "pi",
): Record<string, string | null> {
  const capabilities = deployment.config.model.capabilities;
  const supported = capabilities.supportedReasoningLevels ?? [];
  const wireByCanonical = new Map<ReasoningLevel, string>();
  for (const wireLevel of supported) {
    const canonical = capabilities.reasonLevelMap?.[wireLevel] ?? wireLevel;
    if (!Object.hasOwn(deployment.base.clients.reasoningLevels.pi, canonical)) {
      throw new Error(`Reasoning level ${wireLevel} needs a canonical reasonLevelMap entry`);
    }
    wireByCanonical.set(canonical as ReasoningLevel, wireLevel);
  }
  const clientLevels = deployment.base.clients.reasoningLevels[client];
  return Object.fromEntries(
    (Object.keys(clientLevels) as ReasoningLevel[]).flatMap((level) => {
      const clientLevel = clientLevels[level];
      return clientLevel === null ? [] : [[clientLevel, wireByCanonical.get(level) ?? null]];
    }),
  );
}

function reasoningEffortAliases(deployment: ResolvedDeployment): Record<string, string> {
  const capabilities = deployment.config.model.capabilities;
  const aliases: Record<string, string> = {};
  for (const wireLevel of capabilities.supportedReasoningLevels ?? []) {
    const canonical = (capabilities.reasonLevelMap?.[wireLevel] ?? wireLevel) as ReasoningLevel;
    aliases[wireLevel] = wireLevel;
    aliases[canonical] = wireLevel;
    for (const client of ["vscode", "pi"] as const) {
      const clientLevel = deployment.base.clients.reasoningLevels[client][canonical];
      if (clientLevel !== null) aliases[clientLevel] = wireLevel;
    }
  }
  return aliases;
}

export function buildVscodeProvider(
  deployment: ResolvedDeployment,
  baseUrl?: string,
): JsonObject | undefined {
  const client = deployment.vscode;
  if (!client) return undefined;
  const config = deployment.config;
  if (config.backend.kind !== "llama.cpp") {
    throw new Error(`Cannot generate a VS Code provider for ${config.backend.kind}`);
  }
  const endpoint = deployment.proxy?.listen ?? config.backend.listen;
  const capabilities = config.model.capabilities;
  const reasoningLevels = clientReasoningLevelMap(deployment, "vscode");
  const model: JsonObject = {
    id: config.model.id,
    name: config.model.name,
    url: baseUrl
      ? `${baseUrl.replace(/\/$/, "")}/responses`
      : `http://${endpoint.host}:${endpoint.port}/v1/responses`,
    toolCalling: capabilities.tools,
    vision: capabilities.vision,
    thinking: capabilities.reasoning,
    streaming: capabilities.streaming,
    zeroDataRetentionEnabled: true,
    ...(capabilities.supportedReasoningLevels
      ? {
        supportsReasoningEffort: Object.entries(reasoningLevels)
          .filter(([, wireLevel]) => wireLevel !== null)
          .map(([clientLevel]) => clientLevel),
      }
      : {}),
    contextWindow: config.runtime.contextWindow,
    maxOutputTokens: config.runtime.maxOutputTokens,
  };
  return {
    name: client.providerName,
    vendor: client.vendor,
    apiType: "responses",
    models: [model],
    settings: { [config.model.id]: { reasoningEffort: client.reasoningEffort } },
  };
}

export function buildPiProvider(deployment: ResolvedDeployment, baseUrl: string): JsonObject {
  const config = deployment.config;
  return {
    providers: {
      [config.name]: {
        baseUrl,
        api: "openai-responses",
        apiKey: "local",
        models: [
          {
            id: config.model.id,
            name: config.model.name,
            reasoning: config.model.capabilities.reasoning,
            ...(config.model.capabilities.supportedReasoningLevels
              ? { thinkingLevelMap: clientReasoningLevelMap(deployment, "pi") }
              : {}),
            input: config.model.capabilities.vision ? ["text", "image"] : ["text"],
            contextWindow: config.runtime.contextWindow,
            maxTokens: config.runtime.maxOutputTokens,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    },
  };
}

export function apiJsonDirectory(deployment: ResolvedDeployment): string {
  const modelDirectory = deployment.config.model.id.replaceAll(/[^A-Za-z0-9._-]/g, "-");
  return `${PROJECT_ROOT}/api-jsons/${modelDirectory}`;
}

export function mergeVscodeProvider(existing: unknown, generated: JsonObject): JsonObject[] {
  if (!Array.isArray(existing)) {
    throw new Error("VS Code chatLanguageModels.json must contain an array");
  }
  const output = [...existing] as JsonObject[];
  const index = output.findIndex((provider) =>
    provider !== null && typeof provider === "object" &&
    provider.name === generated.name && provider.vendor === generated.vendor
  );
  if (index === -1) output.push(generated);
  else output[index] = generated;
  return output;
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  await Deno.mkdir(dirname(path), { recursive: true });
  const temporary = await Deno.makeTempFile({ dir: dirname(path), prefix: ".lm-tools-" });
  try {
    await Deno.writeTextFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
    await Deno.rename(temporary, path);
  } catch (error) {
    await Deno.remove(temporary).catch(() => undefined);
    throw error;
  }
}

async function writeVscodeProvider(deployment: ResolvedDeployment): Promise<string | undefined> {
  const generated = buildVscodeProvider(deployment);
  if (!generated || !deployment.vscode) return undefined;
  const path = deployment.vscode.configPath;
  let existing: unknown = [];
  try {
    existing = JSON.parse(await Deno.readTextFile(path));
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  await writeJsonAtomically(path, mergeVscodeProvider(existing, generated));
  return path;
}

export function tailscaleApiBaseUrl(dnsName: string, httpsPort: number): string {
  const host = dnsName.replace(/\.$/, "");
  const port = httpsPort === 443 ? "" : `:${httpsPort}`;
  return `https://${host}${port}/v1`;
}

async function clientApiBaseUrl(deployment: ResolvedDeployment): Promise<string> {
  if (!deployment.tailscaleServe) {
    const endpoint = deploymentHttpEndpoint(deployment);
    return `http://${endpoint.host}:${endpoint.port}/v1`;
  }
  const tailscaleServe = deployment.tailscaleServe;
  const output = await new Deno.Command(tailscaleServe.executable, {
    args: ["status", "--json"],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) {
    const stderr = new TextDecoder().decode(output.stderr).trim();
    throw new Error(
      `${tailscaleServe.executable} status --json failed (${output.code})${
        stderr ? `: ${stderr}` : ""
      }`,
    );
  }
  const status = JSON.parse(new TextDecoder().decode(output.stdout));
  const dnsName = status?.Self?.DNSName;
  if (typeof dnsName !== "string" || dnsName.length === 0) {
    throw new Error("Tailscale status did not include Self.DNSName");
  }
  return tailscaleApiBaseUrl(dnsName, tailscaleServe.httpsPort);
}

async function writeApiJsons(deployment: ResolvedDeployment): Promise<string[] | undefined> {
  if (deployment.config.backend.kind !== "llama.cpp") return undefined;
  const directory = apiJsonDirectory(deployment);
  const baseUrl = await clientApiBaseUrl(deployment);
  const outputs: Array<[string, JsonObject | undefined]> = [
    [`${directory}/vscode.json`, buildVscodeProvider(deployment, baseUrl)],
    [`${directory}/pi.json`, buildPiProvider(deployment, baseUrl)],
  ];
  const written: string[] = [];
  for (const [path, value] of outputs) {
    if (!value) continue;
    await writeJsonAtomically(path, value);
    written.push(path);
  }
  return written;
}

function buildDiffusionRunnerArgs(backend: LlamaCppDiffusionBackend): string[] {
  return [
    "-dev",
    backend.device,
    "-ngl",
    backend.gpuLayers === "all" ? "999" : String(backend.gpuLayers),
    "--fit",
    backend.fit.enabled ? "on" : "off",
    ...(backend.fit.enabled ? ["--fit-target", String(backend.fit.marginMiB)] : []),
    "-fa",
    backend.flashAttention,
  ];
}

function resolveProcessService(
  deployment: ResolvedDeployment,
  service: ProcessService | DiffusionGemmaLabService,
): ResolvedProcessService {
  if (service.kind === "process") return service;
  const backend = deployment.config.backend;
  if (backend.kind !== "llama.cpp-diffusion") {
    throw new Error(`${service.kind} requires backend.kind=llama.cpp-diffusion`);
  }
  return {
    name: service.name,
    executable: "/usr/bin/npm",
    args: ["run", "dev"],
    cwd: service.checkout,
    environment: {
      PORT: String(service.listen.port),
      MODEL_PATH: deployment.config.model.path,
      LLAMA_BINARY: backend.executable,
      LLAMA_EXTRA_ARGS: buildDiffusionRunnerArgs(backend).join(" "),
      SKIP_MODEL_SETUP: "1",
    },
    ready: {
      url: `http://${service.listen.host}:${service.listen.port}/api/status`,
      timeoutSeconds: service.readyTimeoutSeconds,
    },
  };
}

async function validateInstalledBackend(
  deployment: ResolvedDeployment,
  requireModel = true,
): Promise<void> {
  const backend = deployment.config.backend;
  if (requireModel) {
    try {
      await assertFile(deployment.config.model.path, "Model");
    } catch (error) {
      if (!deployment.config.model.source) throw error;
      throw new Error(
        `${
          error instanceof Error ? error.message : error
        }; run lm deploy ${deployment.sourcePath} --fetch`,
      );
    }
  }
  await assertFile(backend.executable, backend.kind, true);
  const output = await new Deno.Command(backend.executable, {
    args: ["--help"],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) throw new Error(`${backend.executable} --help failed`);
  const help = new TextDecoder().decode(output.stdout);
  const emitted = backend.kind === "llama.cpp"
    ? buildLlamaArgs(deployment.llama!)
    : buildDiffusionRunnerArgs(backend);
  const unsupported = [...new Set(emitted.filter((arg) => arg.startsWith("-")))]
    .filter((option) => !help.includes(option));
  if (unsupported.length > 0) {
    throw new Error(`${backend.executable} does not support: ${unsupported.join(", ")}`);
  }
  if (backend.kind === "llama.cpp") {
    if (deployment.llama?.mmproj) await assertFile(deployment.llama.mmproj, "Vision projector");
  } else {
    const devices = await new Deno.Command(backend.executable, {
      args: ["--list-devices"],
      stdout: "piped",
      stderr: "piped",
    }).output();
    const deviceOutput = new TextDecoder().decode(devices.stdout) +
      new TextDecoder().decode(devices.stderr);
    if (!devices.success || !deviceOutput.includes(`${backend.device}:`)) {
      throw new Error(`Diffusion runner does not expose configured device ${backend.device}`);
    }
  }
  if ((deployment.config.services?.length ?? 0) > 0) {
    await assertFile("/usr/bin/setsid", "Service process-group launcher", true);
  }
  if (deployment.tailscaleServe) {
    await assertFile(deployment.tailscaleServe.executable, "Tailscale executable", true);
  }
  const gpu = deployment.config.resources?.gpu;
  if (gpu?.mode === "exclusive") {
    for (const executable of gpu.conflictingExecutables) {
      await assertFile(executable, "Conflicting GPU executable", true);
    }
    await assertFile(`${gpu.vram.devicePath}/mem_info_vram_total`, "GPU VRAM total counter");
    await assertFile(`${gpu.vram.devicePath}/mem_info_vram_used`, "GPU VRAM used counter");
  }
  for (const service of deployment.config.services ?? []) {
    const resolved = resolveProcessService(deployment, service);
    await assertFile(resolved.executable, `Service ${resolved.name} executable`, true);
    const cwd = await Deno.stat(resolved.cwd).catch(() => undefined);
    if (!cwd?.isDirectory) {
      throw new Error(`Service ${resolved.name} cwd not found: ${resolved.cwd}`);
    }
  }
}

async function fetchModelArtifact(deployment: ResolvedDeployment): Promise<void> {
  const { path, source } = deployment.config.model;
  if (!source) throw new Error(`Model ${deployment.config.model.id} has no source to fetch`);
  try {
    await Deno.stat(path);
    console.log(`Verifying existing model artifact: ${path}`);
    await verifyFileIntegrity(path, source.size, source.sha256);
    console.log(`Verified model artifact: ${path}`);
    return;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  console.log(`Fetching model artifact: ${source.url}`);
  const url = new URL(source.url);
  await downloadFile({
    url,
    output: path,
    connections: recommendedConnections(url),
    chunkBytes: 64 * 1024 * 1024,
    expectedSize: source.size,
    sha256: source.sha256,
  });
}

function deploymentHttpEndpoint(deployment: ResolvedDeployment): ListenAddress {
  const backend = deployment.config.backend;
  if (backend.kind !== "llama.cpp") throw new Error(`${backend.kind} has no HTTP endpoint`);
  return deployment.proxy?.listen ?? backend.listen;
}

export function buildTailscaleServeArgs(deployment: ResolvedDeployment, disable = false): string[] {
  const tailscaleServe = deployment.tailscaleServe;
  if (!tailscaleServe) return [];
  if (disable) return ["serve", `--https=${tailscaleServe.httpsPort}`, "off"];
  const endpoint = deploymentHttpEndpoint(deployment);
  return [
    "serve",
    "--bg",
    `--https=${tailscaleServe.httpsPort}`,
    `http://${endpoint.host}:${endpoint.port}`,
  ];
}

async function runTailscaleServeCommand(
  deployment: ResolvedDeployment,
  disable = false,
): Promise<void> {
  const tailscaleServe = deployment.tailscaleServe;
  if (!tailscaleServe) return;
  const args = buildTailscaleServeArgs(deployment, disable);
  const output = await new Deno.Command(tailscaleServe.executable, {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) {
    const stderr = new TextDecoder().decode(output.stderr).trim();
    throw new Error(
      `${tailscaleServe.executable} ${args.map(shellQuote).join(" ")} failed (${output.code})${
        stderr ? `: ${stderr}` : ""
      }`,
    );
  }
}

async function withTailscaleServe(
  deployment: ResolvedDeployment,
  run: () => Promise<void>,
): Promise<void> {
  if (!deployment.tailscaleServe) return await run();
  await runTailscaleServeCommand(deployment);
  console.log(
    `Tailscale Serve enabled on HTTPS port ${deployment.tailscaleServe.httpsPort}`,
  );
  try {
    await run();
  } finally {
    try {
      await runTailscaleServeCommand(deployment, true);
    } catch (error) {
      console.error(`Could not disable Tailscale Serve: ${error}`);
    }
  }
}

function printPlan(deployment: ResolvedDeployment): void {
  console.log(`Deployment: ${deployment.config.name}`);
  console.log(`Backend:    ${deployment.config.backend.kind}`);
  if (deployment.llama) {
    const command = [
      deployment.llama.server,
      ...buildLlamaArgs({
        ...deployment.llama,
        serverArgs: ["--alias", deployment.config.model.id],
      }),
    ].map(shellQuote).join(" ");
    console.log(`Process:    ${command}`);
  } else {
    const backend = deployment.config.backend;
    if (backend.kind !== "llama.cpp-diffusion") throw new Error("Unsupported backend");
    console.log(
      `Runner:     ${
        [backend.executable, ...buildDiffusionRunnerArgs(backend)].map(shellQuote).join(" ")
      }`,
    );
  }
  if (deployment.proxy) {
    console.log(
      `Proxy:      http://${deployment.proxy.listen.host}:${deployment.proxy.listen.port}/v1/responses`,
    );
  }
  if (deployment.tailscaleServe) {
    console.log(
      `Tailscale:  ${
        [deployment.tailscaleServe.executable, ...buildTailscaleServeArgs(deployment)].map(
          shellQuote,
        )
          .join(" ")
      }`,
    );
  }
  if (deployment.vscode) {
    console.log(`VS Code:    ${deployment.vscode.configPath}`);
    console.log(JSON.stringify(buildVscodeProvider(deployment), null, 2));
  }
  for (const service of deployment.config.services ?? []) {
    const resolved = resolveProcessService(deployment, service);
    const process = [resolved.executable, ...resolved.args].map(shellQuote).join(" ");
    console.log(`Service:    ${resolved.name}: ${process}`);
    console.log(`Ready:      ${resolved.ready.url}`);
  }
}

async function waitForUrl(
  name: string,
  url: string,
  timeoutSeconds: number,
  child: Deno.ChildProcess,
): Promise<void> {
  const deadline = performance.now() + timeoutSeconds * 1000;
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
      // The process is still starting.
    }
  }
  throw new Error(`Timed out waiting for ${name} at ${url}`);
}

async function mirrorProcessOutput(
  stream: ReadableStream<Uint8Array>,
  destination: { write(data: Uint8Array): Promise<number> },
  diagnostics: DiagnosticLog,
  source: string,
  channel: "stdout" | "stderr",
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
        diagnostics.log(source, channel, { line: buffered.slice(0, newline) });
        buffered = buffered.slice(newline + 1);
      }
    }
    buffered += decoder.decode();
    if (buffered) diagnostics.log(source, channel, { line: buffered });
  } finally {
    reader.releaseLock();
  }
}

async function runDeploymentServices(deployment: ResolvedDeployment): Promise<void> {
  const llama = deployment.llama
    ? {
      ...deployment.llama,
      serverArgs: ["--alias", deployment.config.model.id],
    }
    : undefined;
  const diagnostics = defaultDiagnosticLog();
  diagnostics.log("deployment", "started", { name: deployment.config.name });
  const children: Array<{
    name: string;
    child: Deno.ChildProcess;
    outputTasks: Promise<void>[];
    processGroup: boolean;
  }> = [];
  let llamaChild: Deno.ChildProcess | undefined;
  if (llama) {
    llamaChild = spawnLlama(llama, "piped");
    children.push({
      name: "llama-server",
      child: llamaChild,
      processGroup: false,
      outputTasks: [
        mirrorProcessOutput(
          llamaChild.stdout,
          Deno.stdout,
          diagnostics,
          "llama-server",
          "stdout",
        ),
        mirrorProcessOutput(
          llamaChild.stderr,
          Deno.stderr,
          diagnostics,
          "llama-server",
          "stderr",
        ),
      ],
    });
  }
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const { child, processGroup } of children) {
      try {
        if (processGroup) Deno.kill(-child.pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch {
        // The child may already have exited.
      }
    }
  };
  Deno.addSignalListener("SIGINT", shutdown);
  Deno.addSignalListener("SIGTERM", shutdown);
  try {
    if (llama && llamaChild) {
      await waitForUrl(
        "llama-server",
        `http://${llama.host}:${llama.port}/health`,
        120,
        llamaChild,
      );
      console.log("llama-server is ready");
    }
    for (const service of deployment.config.services ?? []) {
      const resolved = resolveProcessService(deployment, service);
      const child = new Deno.Command("/usr/bin/setsid", {
        args: [resolved.executable, ...resolved.args],
        cwd: resolved.cwd,
        env: { ...Deno.env.toObject(), ...resolved.environment },
        stdin: "inherit",
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      children.push({
        name: resolved.name,
        child,
        processGroup: true,
        outputTasks: [
          mirrorProcessOutput(child.stdout, Deno.stdout, diagnostics, resolved.name, "stdout"),
          mirrorProcessOutput(child.stderr, Deno.stderr, diagnostics, resolved.name, "stderr"),
        ],
      });
      await waitForUrl(resolved.name, resolved.ready.url, resolved.ready.timeoutSeconds, child);
      console.log(`${resolved.name} is ready: ${resolved.ready.url}`);
    }
    const outcome = await Promise.race(
      children.map(({ name, child }) => child.status.then((status) => ({ name, status }))),
    );
    if (!shuttingDown) {
      throw new Error(`${outcome.name} exited (${outcome.status.code})`);
    }
  } finally {
    shutdown();
    Deno.removeSignalListener("SIGINT", shutdown);
    Deno.removeSignalListener("SIGTERM", shutdown);
    const gpu = deployment.config.resources?.gpu;
    const graceMs = gpu?.mode === "exclusive" ? gpu.shutdownGraceSeconds * 1000 : 5000;
    const terminations = await Promise.all(
      children.map(({ child, processGroup }) => terminateChild(child, graceMs, processGroup)),
    );
    for (const [index, termination] of terminations.entries()) {
      if (termination === "killed") {
        console.error(`${children[index].name} ignored SIGTERM and was killed`);
      }
    }
    await Promise.allSettled(children.flatMap(({ outputTasks }) => outputTasks));
    diagnostics.log("deployment", "stopped", { name: deployment.config.name });
    await diagnostics.flush();
  }
}

export async function deployCommand(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(deployUsage());
    return;
  }
  let path = DEFAULT_DEPLOYMENT;
  let check = false;
  let dryRun = false;
  let fetch = false;
  let clientOnly = false;
  let positionalSeen = false;
  for (const arg of args) {
    if (arg === "--check") check = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--fetch") fetch = true;
    else if (arg === "--client-only") clientOnly = true;
    else if (arg.startsWith("-")) throw new Error(`Unknown deploy option: ${arg}`);
    else if (positionalSeen) throw new Error("Only one deployment CONFIG is accepted");
    else {
      path = arg;
      positionalSeen = true;
    }
  }

  const deployment = await loadDeployment(path);
  if ([check, dryRun, fetch, clientOnly].filter(Boolean).length > 1) {
    throw new Error("Use only one of --check, --dry-run, --fetch, or --client-only");
  }
  if (fetch) {
    await fetchModelArtifact(deployment);
    return;
  }
  await validateInstalledBackend(deployment, !dryRun);
  if (check) {
    console.log(`Valid deployment: ${deployment.config.name} (${deployment.sourcePath})`);
    return;
  }
  if (dryRun) {
    printPlan(deployment);
    return;
  }
  const written = await writeVscodeProvider(deployment);
  if (written) console.log(`Reconciled VS Code model configuration: ${written}`);
  const apiJsons = await writeApiJsons(deployment);
  if (apiJsons?.length) console.log(`Generated API client JSON: ${apiJsons.join(", ")}`);
  if (clientOnly) return;

  if (deployment.proxy && (deployment.config.services?.length ?? 0) > 0) {
    throw new Error("Auxiliary services and the Responses proxy cannot yet share one deployment");
  }
  const gpu = deployment.config.resources?.gpu;
  const releaseLease = gpu?.mode === "exclusive"
    ? await acquireExclusiveLease(
      `${Deno.env.get("XDG_RUNTIME_DIR") ?? "/tmp"}/lm-tools-gpu-exclusive.lock`,
      gpu.shutdownGraceSeconds * 1000,
    )
    : undefined;
  try {
    if (gpu?.mode === "exclusive") {
      const evicted = await evictConflictingProcesses(
        [...new Set([...gpu.conflictingExecutables, deployment.config.backend.executable])],
        gpu.shutdownGraceSeconds * 1000,
      );
      for (const process of evicted) {
        console.log(
          `Evicted conflicting GPU process ${process.pid} (${process.executable}, ${process.outcome})`,
        );
      }
      const expectedVramMiB = deployment.config.runtime.expectedVramMiB;
      if (!expectedVramMiB) {
        throw new Error(
          `Exclusive GPU deployment ${deployment.config.name} must declare runtime.expectedVramMiB`,
        );
      }
      await requireModelVram(
        gpu.vram.devicePath,
        expectedVramMiB,
        gpu.vram.minimumRemainingMiB,
      );
    }
    await withTailscaleServe(deployment, async () => {
      if (deployment.proxy) {
        if (!deployment.llama) {
          throw new Error("Responses proxy requires a llama.cpp server backend");
        }
        await runVscodeStack(deployment.llama, {
          proxyHost: deployment.proxy.listen.host,
          proxyPort: deployment.proxy.listen.port,
          modelAlias: deployment.config.model.id,
          reasoningEffortMap: reasoningEffortAliases(deployment),
          shutdownGraceMs: gpu?.mode === "exclusive" ? gpu.shutdownGraceSeconds * 1000 : 5000,
        });
      } else if ((deployment.config.services?.length ?? 0) > 0) {
        await runDeploymentServices(deployment);
      } else if (deployment.llama) {
        await runLlama({
          ...deployment.llama,
          serverArgs: ["--alias", deployment.config.model.id],
        });
      } else {
        throw new Error(`${deployment.config.backend.kind} requires at least one service`);
      }
    });
  } finally {
    await releaseLease?.();
  }
}
