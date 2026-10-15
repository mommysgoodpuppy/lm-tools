/**
 * Campaign-owned free-router session.
 *
 * A bounded campaign runs its free-router process for exactly the duration of
 * one attempt instead of depending on a standing router service. The session
 * starts from a resolved, credential-free route configuration, publishes its
 * materialized config, audit journal, and startup/shutdown receipts beneath a
 * campaign artifact directory, and terminates reliably on explicit shutdown,
 * disposal, or external cancellation. Because the server lives inside this
 * process, an interrupted campaign cannot leave an orphaned router behind.
 *
 * Credentials are never part of the session surface. The generic OMP
 * credential gateway keeps its own bearer token file; only its in-memory token
 * is loaded here and it is never written to disk or returned.
 */

import { join } from "jsr:@std/path@1";
import type { RouterAttemptEvent } from "./free_router.ts";
import type { FreeRouterModelConfig, FreeRouterServiceConfig } from "./free_router_server.ts";
import { createFreeRouterHandler } from "./free_router_server.ts";
import { OmpGatewayAdapter } from "./omp_gateway.ts";
import { AppendOnlyTextLog } from "./log.ts";
import {
  type FreeRouterPublicModelIdentity,
  freeRouterPublicModelIdentity,
} from "./free_router_omp.ts";

export type FreeRouterShutdownReason = "explicit" | "disposed" | "cancelled" | "failure";

export interface FreeRouterSessionOptions {
  /** Fixed listen address for this campaign run. */
  listen: { host: string; port: number };
  /**
   * Resolved, credential-free public lanes. Each must declare at least one
   * offer; the router can therefore never fall back to an undeclared
   * provider or model.
   */
  models: readonly FreeRouterModelConfig[];
  policy?: Partial<FreeRouterServiceConfig["policy"]>;
  /**
   * The persistent host credential gateway. Its bearer token file, when
   * declared, is read into memory and never materialized into artifacts.
   */
  ompGateway: { baseUrl: string; bearerTokenFile?: string };
  /** Directory receiving config.json, audit.jsonl, and receipt.json. */
  artifactsDirectory: string;
  readinessTimeoutMs?: number;
  /** External cancellation; triggers an automatic shutdown receipt. */
  signal?: AbortSignal;
}

export interface FreeRouterSessionReceipt {
  listen: { host: string; port: number };
  baseUrl: string;
  publicModels: FreeRouterPublicModelIdentity[];
  /** SHA-256 over the canonical materialized, credential-free route config. */
  configSha256: string;
  ompGateway: { baseUrl: string };
  startedAt: string;
  readyAt?: string;
  shutdown?: { at: string; reason: FreeRouterShutdownReason };
}

export interface FreeRouterSession {
  /** Base URL reachable from the OMP execution environment, including `/v1`. */
  baseUrl: string;
  publicModels: FreeRouterPublicModelIdentity[];
  configPath: string;
  auditPath: string;
  receiptPath: string;
  receipt(): FreeRouterSessionReceipt;
  /** Idempotent; records the shutdown receipt and releases the port lease. */
  shutdown(reason?: FreeRouterShutdownReason): Promise<FreeRouterSessionReceipt>;
  [Symbol.asyncDispose](): Promise<void>;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
        .join(",")
    }}`;
  }
  return JSON.stringify(value) ?? "null";
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Fail-fast port lease. Unlike the GPU lease this never terminates another
 * owner: a live campaign router on the port is an error, not a conflict to
 * evict.
 */
async function acquirePortLease(port: number): Promise<() => Promise<void>> {
  const runtime = Deno.env.get("XDG_RUNTIME_DIR") ?? "/tmp";
  const path = join(runtime, `lm-tools-free-router-${port}.lock`);
  const file = await Deno.open(path, { write: true, createNew: true }).catch((error) => {
    if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
    throw new Error(
      `Campaign free-router port ${port} is already leased at ${path}; ` +
        `another campaign run owns it`,
    );
  });
  await file.write(new TextEncoder().encode(String(Deno.pid)));
  file.close();
  return async () => {
    const owner = await Deno.readTextFile(path).catch(() => "");
    if (owner.trim() === String(Deno.pid)) await Deno.remove(path);
  };
}

async function pollReadiness(
  listen: { host: string; port: number },
  declaredModelIds: readonly string[],
  timeoutMs: number,
  server: Deno.HttpServer,
  controller: AbortController,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  const declared = new Set(declaredModelIds);
  for (;;) {
    if (Date.now() > deadline) {
      controller.abort();
      await server.finished.catch(() => {});
      throw new Error(
        `Campaign free-router did not become ready within ${timeoutMs}ms on ` +
          `${listen.host}:${listen.port}`,
      );
    }
    try {
      const response = await fetch(`http://${listen.host}:${listen.port}/healthz`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) {
        const health = await response.json() as { eligibleModels?: string[] };
        const eligible = new Set(health.eligibleModels ?? []);
        if ([...declared].every((id) => eligible.has(id))) {
          return new Date().toISOString();
        }
      }
    } catch {
      // Not accepting connections yet.
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 50);
    await promise;
  }
}

export async function startFreeRouterSession(
  options: FreeRouterSessionOptions,
): Promise<FreeRouterSession> {
  if (options.models.length === 0) {
    throw new Error("Campaign free-router session requires at least one public model");
  }
  for (const model of options.models) {
    if (model.offers.length === 0) {
      throw new Error(`Campaign free-router model ${model.id} declares no offers`);
    }
  }

  const startedAt = new Date().toISOString();
  await Deno.mkdir(options.artifactsDirectory, { recursive: true });
  const releaseLease = await acquirePortLease(options.listen.port);

  const config: FreeRouterServiceConfig = {
    version: 1,
    listen: options.listen,
    omp: { baseUrl: options.ompGateway.baseUrl },
    ...(options.policy ? { policy: options.policy } : {}),
    models: [...options.models],
  };
  const configPath = join(options.artifactsDirectory, "config.json");
  const auditPath = join(options.artifactsDirectory, "audit.jsonl");
  const receiptPath = join(options.artifactsDirectory, "receipt.json");
  const configSha256 = await sha256(canonicalJson(config));
  await Deno.writeTextFile(configPath, JSON.stringify(config, null, 2) + "\n");

  const audit = new AppendOnlyTextLog(auditPath, { mode: 0o600 });
  const auditEvent = (event: RouterAttemptEvent | Record<string, unknown>) => {
    void audit.append(`${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
  };

  const token = options.ompGateway.bearerTokenFile
    ? (await Deno.readTextFile(options.ompGateway.bearerTokenFile)).trim()
    : undefined;
  if (options.ompGateway.bearerTokenFile && !token) {
    await Deno.remove(configPath);
    await releaseLease();
    throw new Error(
      `OMP gateway bearer token file is empty: ${options.ompGateway.bearerTokenFile}`,
    );
  }

  const adapter = new OmpGatewayAdapter({
    baseUrl: options.ompGateway.baseUrl,
    bearerToken: token,
  });
  const controller = new AbortController();

  const baseUrl = `http://${options.listen.host}:${options.listen.port}/v1`;
  const publicModels = options.models.map((model) =>
    freeRouterPublicModelIdentity(config, model.id)
  );

  const server = Deno.serve({
    hostname: options.listen.host,
    port: options.listen.port,
    signal: controller.signal,
    onListen: () => {},
  }, createFreeRouterHandler(config, adapter, auditEvent));

  let readyAt: string;
  try {
    readyAt = await pollReadiness(
      options.listen,
      options.models.map((model) => model.id),
      options.readinessTimeoutMs ?? 10_000,
      server,
      controller,
    );
  } catch (error) {
    await audit.flush();
    await Deno.remove(configPath).catch(() => {});
    await Deno.remove(auditPath).catch(() => {});
    await releaseLease();
    throw error;
  }

  const receipt: FreeRouterSessionReceipt = {
    listen: options.listen,
    baseUrl,
    publicModels,
    configSha256,
    ompGateway: { baseUrl: options.ompGateway.baseUrl },
    startedAt,
    readyAt,
  };
  const writeReceipt = () =>
    Deno.writeTextFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
  await writeReceipt();

  let stopPromise: Promise<FreeRouterSessionReceipt> | undefined;
  const performStop = async (reason: FreeRouterShutdownReason) => {
    receipt.shutdown = { at: new Date().toISOString(), reason };
    controller.abort();
    await server.finished.catch(() => {});
    await audit.flush();
    await writeReceipt();
    await releaseLease();
    return structuredClone(receipt);
  };
  const session: FreeRouterSession = {
    baseUrl,
    publicModels,
    configPath,
    auditPath,
    receiptPath,
    receipt: () => structuredClone(receipt),
    async shutdown(reason: FreeRouterShutdownReason = "explicit") {
      stopPromise ??= performStop(reason);
      return await stopPromise;
    },
    async [Symbol.asyncDispose]() {
      await session.shutdown("disposed");
    },
  };
  if (options.signal) {
    if (options.signal.aborted) void session.shutdown("cancelled");
    else {
      options.signal.addEventListener("abort", () => {
        void session.shutdown("cancelled");
      }, { once: true });
    }
  }
  return session;
}
