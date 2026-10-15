import { createHash } from "node:crypto";
import { join, relative, resolve } from "jsr:@std/path@1";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface CampaignDefinition<T> {
  id: string;
  run(context: CampaignContext): Promise<T>;
}

export interface CampaignRunOptions {
  /** Durable orchestration state. Attempt artifacts are stored beneath this directory. */
  stateDirectory: string;
}

export interface AttemptIdentity {
  /** Stable name of this effect inside the campaign program. */
  operation: string;
  /**
   * Arbitrary JSON selected by the campaign program to identify its resolved inputs.
   * lm-tools fingerprints and preserves this value but does not interpret it.
   */
  inputs: JsonValue;
}

export interface AttemptWorkspace {
  id: string;
  directory: string;
  artifactsDirectory: string;
}

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export type AttemptTermination =
  | { kind: "completed"; exitCode: number }
  | { kind: "timeout"; exitCode: number | null }
  | { kind: "aborted"; reason?: string }
  | { kind: "failed"; error: string };

export interface AttemptExecution {
  termination: AttemptTermination;
  usage?: TokenUsage;
}

export interface AttemptArtifact {
  path: string;
  bytes: number;
  sha256: string;
}

export interface AttemptRecord {
  version: 1;
  campaign: string;
  operation: string;
  id: string;
  fingerprint: string;
  startedAt: string;
  finishedAt: string;
  durationSeconds: number;
  termination: AttemptTermination;
  usage?: TokenUsage;
  artifacts: AttemptArtifact[];
}

export interface CampaignContext {
  readonly campaignId: string;
  readonly stateDirectory: string;

  /**
   * Run one durable effect. Re-executing the campaign with the same operation and
   * input fingerprint returns the recorded attempt without invoking execute again.
   * To retry or branch, the campaign program deliberately changes the inputs.
   */
  attempt(
    identity: AttemptIdentity,
    execute: (workspace: AttemptWorkspace) => Promise<AttemptExecution>,
  ): Promise<AttemptRecord>;
}

interface AttemptStatus {
  version: 1;
  state: "running";
  campaign: string;
  operation: string;
  id: string;
  fingerprint: string;
  startedAt: string;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

function validateId(value: string, kind: string): void {
  if (!SAFE_ID.test(value)) {
    throw new Error(`${kind} must match ${SAFE_ID}: ${value}`);
  }
}

/** Stable JSON encoding used only for fingerprints and preserved input snapshots. */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Campaign fingerprint numbers must be finite");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object") throw new Error("Campaign fingerprints must be JSON values");
  return `{${
    Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")
  }}`;
}

async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface AttemptLocation {
  directory: string;
  artifactsDirectory: string;
  recordPath: string;
  statusPath: string;
  fingerprint: string;
  id: string;
}

/**
 * Deterministic on-disk location of one named attempt. Recovery code and
 * campaign programs use it to decide whether external resources — a
 * campaign-owned router, a container, a long analysis — must be started at
 * all, without claiming or running the attempt.
 */
export async function planAttempt(
  stateDirectory: string,
  campaignId: string,
  identity: AttemptIdentity,
): Promise<AttemptLocation> {
  validateId(identity.operation, "Attempt operation");
  const inputSnapshot = {
    version: 1,
    campaign: campaignId,
    operation: identity.operation,
    inputs: identity.inputs,
  } satisfies JsonValue;
  const fingerprint = await sha256Text(canonicalJson(inputSnapshot));
  const directory = join(stateDirectory, "attempts", identity.operation, fingerprint);
  return {
    directory,
    artifactsDirectory: join(directory, "artifacts"),
    recordPath: join(directory, "record.json"),
    statusPath: join(directory, "status.json"),
    fingerprint,
    id: `${identity.operation}-${fingerprint.slice(0, 16)}`,
  };
}

/** Read the durable record of a named attempt without claiming or running it. */
export async function readAttemptRecord(
  stateDirectory: string,
  campaignId: string,
  identity: AttemptIdentity,
): Promise<AttemptRecord | undefined> {
  const location = await planAttempt(stateDirectory, campaignId, identity);
  try {
    return JSON.parse(await Deno.readTextFile(location.recordPath)) as AttemptRecord;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
}

async function sha256File(path: string): Promise<{ bytes: number; sha256: string }> {
  const file = await Deno.open(path, { read: true });
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    const buffer = new Uint8Array(1024 * 1024);
    while (true) {
      const count = await file.read(buffer);
      if (count === null) break;
      hash.update(buffer.subarray(0, count));
      bytes += count;
    }
  } finally {
    file.close();
  }
  return { bytes, sha256: hash.digest("hex") };
}

async function inventoryArtifacts(root: string): Promise<AttemptArtifact[]> {
  const artifacts: AttemptArtifact[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = [];
    for await (const entry of Deno.readDir(directory)) entries.push(entry);
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory) await visit(path);
      else if (entry.isFile) {
        const identity = await sha256File(path);
        artifacts.push({ path: relative(root, path), ...identity });
      } else if (entry.isSymlink) {
        throw new Error(`Attempt artifacts may not contain symlinks: ${path}`);
      }
    }
  }
  await visit(root);
  return artifacts;
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.tmp-${crypto.randomUUID()}`;
  await Deno.writeTextFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { createNew: true });
  await Deno.rename(temporary, path);
}

async function claimAttempt(path: string, status: AttemptStatus): Promise<boolean> {
  try {
    await Deno.writeTextFile(path, `${JSON.stringify(status, null, 2)}\n`, { createNew: true });
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.AlreadyExists) return false;
    throw error;
  }
}

async function readRecordFile(path: string): Promise<AttemptRecord | undefined> {
  try {
    return JSON.parse(await Deno.readTextFile(path)) as AttemptRecord;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
}

class LocalCampaignContext implements CampaignContext {
  readonly campaignId: string;
  readonly stateDirectory: string;

  constructor(campaignId: string, stateDirectory: string) {
    validateId(campaignId, "Campaign id");
    this.campaignId = campaignId;
    this.stateDirectory = resolve(stateDirectory);
  }

  async attempt(
    identity: AttemptIdentity,
    execute: (workspace: AttemptWorkspace) => Promise<AttemptExecution>,
  ): Promise<AttemptRecord> {
    validateId(identity.operation, "Attempt operation");
    const inputSnapshot = {
      version: 1,
      campaign: this.campaignId,
      operation: identity.operation,
      inputs: identity.inputs,
    } satisfies JsonValue;
    const location = await planAttempt(this.stateDirectory, this.campaignId, identity);
    const { directory, artifactsDirectory, recordPath, statusPath, fingerprint, id } = location;
    const existing = await readRecordFile(recordPath);
    if (existing) return existing;

    await Deno.mkdir(artifactsDirectory, { recursive: true });
    const started = new Date();
    const status: AttemptStatus = {
      version: 1,
      state: "running",
      campaign: this.campaignId,
      operation: identity.operation,
      id,
      fingerprint,
      startedAt: started.toISOString(),
    };
    if (!(await claimAttempt(statusPath, status))) {
      const completed = await readRecordFile(recordPath);
      if (completed) return completed;
      const active = JSON.parse(await Deno.readTextFile(statusPath)) as AttemptStatus;
      throw new Error(
        `Attempt ${active.id} has an unfinished running record from ${active.startedAt}; ` +
          "explicit recovery is required before it can be run again",
      );
    }
    // A prior owner writes record.json before releasing status.json. Recheck after
    // acquiring the claim so a completion racing the initial read is never rerun.
    const completedWhileClaiming = await readRecordFile(recordPath);
    if (completedWhileClaiming) {
      await Deno.remove(statusPath);
      return completedWhileClaiming;
    }
    await writeJsonAtomic(join(directory, "input.json"), inputSnapshot);

    let execution: AttemptExecution;
    try {
      execution = await execute({ id, directory, artifactsDirectory });
    } catch (error) {
      execution = {
        termination: {
          kind: "failed",
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
    const finished = new Date();
    const record: AttemptRecord = {
      version: 1,
      campaign: this.campaignId,
      operation: identity.operation,
      id,
      fingerprint,
      startedAt: started.toISOString(),
      finishedAt: finished.toISOString(),
      durationSeconds: (finished.getTime() - started.getTime()) / 1000,
      termination: execution.termination,
      ...(execution.usage ? { usage: execution.usage } : {}),
      artifacts: await inventoryArtifacts(artifactsDirectory),
    };
    await writeJsonAtomic(recordPath, record);
    await Deno.remove(statusPath);
    return record;
  }
}

export function defineCampaign<T>(definition: CampaignDefinition<T>): CampaignDefinition<T> {
  validateId(definition.id, "Campaign id");
  return definition;
}

/**
 * Execute trusted campaign code. The program's return value is intentionally unconstrained and is
 * not persisted or validated by lm-tools; durable attempt effects are recorded through context.
 */
export async function runCampaign<T>(
  campaign: CampaignDefinition<T>,
  options: CampaignRunOptions,
): Promise<T> {
  const context = new LocalCampaignContext(campaign.id, options.stateDirectory);
  await Deno.mkdir(context.stateDirectory, { recursive: true });
  return await campaign.run(context);
}
