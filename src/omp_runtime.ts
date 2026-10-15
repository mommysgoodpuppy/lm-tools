import { dirname, fromFileUrl, join } from "jsr:@std/path@1";

export interface OmpRuntimePin {
  repository: string;
  tag: string;
  commit: string;
  packageVersion: string;
  runtime: string;
  runtimeVersion: string;
}

export interface ManagedOmpRuntimeReceipt {
  schemaVersion: 1;
  source: {
    repository: string;
    tag: string;
    commit: string;
    packageVersion: string;
  };
  executable: "bin/omp";
  materializedAt: string;
}

export interface ManagedOmpRuntimeLayout {
  root: string;
  executable: string;
  receipt: string;
  pin: OmpRuntimePin;
}

const projectRoot = dirname(dirname(fromFileUrl(import.meta.url)));
const defaultVersionPath = join(projectRoot, "vendor", "omp.version");

function requiredField(fields: ReadonlyMap<string, string>, name: string): string {
  const value = fields.get(name)?.trim();
  if (!value) throw new Error(`OMP runtime pin is missing ${name}`);
  return value;
}

export async function loadOmpRuntimePin(
  versionPath = defaultVersionPath,
): Promise<OmpRuntimePin> {
  const fields = new Map<string, string>();
  for (const rawLine of (await Deno.readTextFile(versionPath)).split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals <= 0) throw new Error(`Malformed OMP runtime pin line: ${rawLine}`);
    fields.set(line.slice(0, equals).trim(), line.slice(equals + 1).trim());
  }
  return {
    repository: requiredField(fields, "repository"),
    tag: requiredField(fields, "tag"),
    commit: requiredField(fields, "commit"),
    packageVersion: requiredField(fields, "package_version"),
    runtime: requiredField(fields, "runtime"),
    runtimeVersion: requiredField(fields, "bun_version"),
  };
}

function defaultDataHome(): string {
  const configured = Deno.env.get("XDG_DATA_HOME")?.trim();
  if (configured) return configured;
  const home = Deno.env.get("HOME")?.trim();
  if (!home) {
    throw new Error(
      "Cannot locate the lm-tools managed runtime: set XDG_DATA_HOME or HOME",
    );
  }
  return join(home, ".local", "share");
}

export async function managedOmpRuntimeLayout(options: {
  dataHome?: string;
  versionPath?: string;
} = {}): Promise<ManagedOmpRuntimeLayout> {
  const pin = await loadOmpRuntimePin(options.versionPath);
  const root = join(
    options.dataHome ?? defaultDataHome(),
    "lm-tools",
    "runtimes",
    "omp",
    pin.commit,
  );
  return {
    root,
    executable: join(root, "bin", "omp"),
    receipt: join(root, "runtime.json"),
    pin,
  };
}

function parseReceipt(value: unknown, path: string): ManagedOmpRuntimeReceipt {
  if (!value || typeof value !== "object") {
    throw new Error(`Managed OMP runtime receipt is not an object: ${path}`);
  }
  const receipt = value as Partial<ManagedOmpRuntimeReceipt>;
  if (
    receipt.schemaVersion !== 1 || receipt.executable !== "bin/omp" ||
    typeof receipt.materializedAt !== "string" || !receipt.source ||
    typeof receipt.source.repository !== "string" || typeof receipt.source.tag !== "string" ||
    typeof receipt.source.commit !== "string" || typeof receipt.source.packageVersion !== "string"
  ) {
    throw new Error(`Managed OMP runtime receipt has an unsupported shape: ${path}`);
  }
  return receipt as ManagedOmpRuntimeReceipt;
}

/**
 * Resolve the only production OMP executable lm-tools may launch.
 *
 * The runtime is namespaced by the reviewed source commit and must carry a
 * matching materialization receipt. This function deliberately never searches
 * PATH and never inspects a system OMP installation.
 */
export async function resolveManagedOmpExecutable(options: {
  dataHome?: string;
  versionPath?: string;
} = {}): Promise<string> {
  const layout = await managedOmpRuntimeLayout(options);
  let receipt: ManagedOmpRuntimeReceipt;
  try {
    receipt = parseReceipt(await Deno.readTextFile(layout.receipt).then(JSON.parse), layout.receipt);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(
        `Managed OMP ${layout.pin.packageVersion} is not materialized at ${layout.root}`,
      );
    }
    throw error;
  }
  const expected = layout.pin;
  if (
    receipt.source.repository !== expected.repository || receipt.source.tag !== expected.tag ||
    receipt.source.commit !== expected.commit ||
    receipt.source.packageVersion !== expected.packageVersion
  ) {
    throw new Error(
      `Managed OMP receipt at ${layout.receipt} does not match pinned commit ${expected.commit}`,
    );
  }
  let stat: Deno.FileInfo;
  try {
    stat = await Deno.stat(layout.executable);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(`Managed OMP receipt exists but executable is missing: ${layout.executable}`);
    }
    throw error;
  }
  if (!stat.isFile) throw new Error(`Managed OMP executable is not a regular file: ${layout.executable}`);
  if (stat.mode !== null && (stat.mode & 0o111) === 0) {
    throw new Error(`Managed OMP executable is not executable: ${layout.executable}`);
  }
  return layout.executable;
}
