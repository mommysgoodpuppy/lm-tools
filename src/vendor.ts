import { Ajv2020, type ErrorObject } from "npm:ajv@8.17.1/dist/2020.js";
import { basename, dirname, resolve } from "jsr:@std/path@1";
import { shellQuote } from "./llama.ts";

const PROJECT_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const VENDOR_SCHEMA = `${PROJECT_ROOT}/schemas/vendor.schema.json`;

interface VendorCheckout {
  name: string;
  repository: string;
  revision: string;
  upstream?: string;
  path: string;
  patches?: string[];
}

interface VendorStep {
  name?: string;
  run: string[];
  cwd?: string;
  environment?: Record<string, string>;
}

interface VendorArtifact {
  name: string;
  path: string;
  kind: "file" | "directory" | "executable";
}

interface VendorManifest {
  $schema?: string;
  version: 1;
  name: string;
  description?: string;
  checkouts: VendorCheckout[];
  steps?: VendorStep[];
  artifacts: VendorArtifact[];
}

export interface ResolvedVendorManifest {
  sourcePath: string;
  manifest: VendorManifest;
  checkouts: Map<string, VendorCheckout & { resolvedPath: string; resolvedPatches: string[] }>;
  artifacts: Map<string, VendorArtifact & { resolvedPath: string }>;
}

export function vendorUsage(): string {
  return `Usage: lm vendor MANIFEST [options]

Materialize or verify a declarative pinned source build.

Options:
  --apply    Clone missing checkouts, apply patches, run build steps, and verify artifacts (default)
  --check    Verify revisions, patches, and artifacts without changing anything
  --dry-run  Print the resolved Git, patch, and build commands
  --help     Show this help

Manifest strings may use \${root}, \${manifest}, and \${checkout.NAME}.
For a manifest in a vendors directory, \${root} is the directory containing vendors.`;
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ");
}

function substitute(value: string, variables: Map<string, string>): string {
  return value.replace(/\$\{([^}]+)\}/g, (_match, name: string) => {
    const replacement = variables.get(name);
    if (!replacement) throw new Error(`Unknown vendor manifest variable: \${${name}}`);
    return replacement;
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

async function run(
  command: string[],
  options: {
    cwd?: string;
    environment?: Record<string, string>;
    capture?: boolean;
    quiet?: boolean;
    trim?: boolean;
  } = {},
): Promise<string> {
  const output = await new Deno.Command(command[0], {
    args: command.slice(1),
    cwd: options.cwd,
    env: options.environment,
    stdin: "inherit",
    stdout: options.capture ? "piped" : options.quiet ? "null" : "inherit",
    stderr: options.quiet ? "null" : "inherit",
  }).output();
  if (!output.success) throw new Error(`${command[0]} exited with status ${output.code}`);
  const captured = options.capture ? new TextDecoder().decode(output.stdout) : "";
  return options.trim === false ? captured : captured.trim();
}

export async function loadVendorManifest(path: string): Promise<ResolvedVendorManifest> {
  const sourcePath = resolve(path);
  const manifest = JSON.parse(await Deno.readTextFile(sourcePath)) as VendorManifest;
  const schema = JSON.parse(await Deno.readTextFile(VENDOR_SCHEMA));
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
  if (!validate(manifest)) {
    throw new Error(`Invalid vendor manifest ${sourcePath}: ${formatAjvErrors(validate.errors)}`);
  }

  const manifestRoot = dirname(sourcePath);
  const ownerRoot = basename(manifestRoot) === "vendors" ? dirname(manifestRoot) : manifestRoot;
  const variables = new Map<string, string>([["root", ownerRoot], ["manifest", manifestRoot]]);
  const checkouts = new Map<
    string,
    VendorCheckout & { resolvedPath: string; resolvedPatches: string[] }
  >();
  for (const checkout of manifest.checkouts) {
    if (checkouts.has(checkout.name)) throw new Error(`Duplicate checkout name: ${checkout.name}`);
    const resolvedPath = resolve(manifestRoot, substitute(checkout.path, variables));
    variables.set(`checkout.${checkout.name}`, resolvedPath);
    checkouts.set(checkout.name, { ...checkout, resolvedPath, resolvedPatches: [] });
  }
  for (const checkout of checkouts.values()) {
    checkout.resolvedPatches = (checkout.patches ?? []).map((patch) =>
      resolve(manifestRoot, substitute(patch, variables))
    );
  }

  const artifacts = new Map<string, VendorArtifact & { resolvedPath: string }>();
  for (const artifact of manifest.artifacts) {
    if (artifacts.has(artifact.name)) throw new Error(`Duplicate artifact name: ${artifact.name}`);
    artifacts.set(artifact.name, {
      ...artifact,
      resolvedPath: resolve(manifestRoot, substitute(artifact.path, variables)),
    });
  }
  return { sourcePath, manifest, checkouts, artifacts };
}

async function patchApplied(checkoutPath: string, patch: string): Promise<boolean> {
  const output = await new Deno.Command("git", {
    args: ["-C", checkoutPath, "apply", "--reverse", "--check", patch],
    stdout: "null",
    stderr: "null",
  }).output();
  return output.success;
}

async function declaredPatchPaths(patches: string[]): Promise<Set<string>> {
  const paths = new Set<string>();
  for (const patch of patches) {
    const text = await Deno.readTextFile(patch);
    for (const line of text.split("\n")) {
      const match = line.match(/^\+\+\+ b\/(.+)$/) ?? line.match(/^--- a\/(.+)$/);
      if (match) paths.add(match[1]);
    }
  }
  return paths;
}

function statusPath(line: string): string {
  const path = line.slice(3);
  return path.includes(" -> ") ? path.split(" -> ").at(-1)! : path;
}

async function checkCheckout(
  checkout: VendorCheckout & { resolvedPath: string; resolvedPatches: string[] },
): Promise<void> {
  if (!(await exists(`${checkout.resolvedPath}/.git`))) {
    throw new Error(`Missing Git checkout ${checkout.name}: ${checkout.resolvedPath}`);
  }
  const actual = await run(["git", "-C", checkout.resolvedPath, "rev-parse", "HEAD"], {
    capture: true,
  });
  if (actual !== checkout.revision) {
    throw new Error(`${checkout.name} is at ${actual}; expected ${checkout.revision}`);
  }
  const remote = await run(["git", "-C", checkout.resolvedPath, "remote", "get-url", "origin"], {
    capture: true,
  });
  if (remote !== checkout.repository) {
    throw new Error(`${checkout.name} origin is ${remote}; expected ${checkout.repository}`);
  }
  for (const patch of checkout.resolvedPatches) {
    if (!(await exists(patch))) throw new Error(`Missing patch for ${checkout.name}: ${patch}`);
    if (!(await patchApplied(checkout.resolvedPath, patch))) {
      throw new Error(`Patch is not applied to ${checkout.name}: ${patch}`);
    }
  }
  const allowedPaths = await declaredPatchPaths(checkout.resolvedPatches);
  const status = await run(
    ["git", "-C", checkout.resolvedPath, "status", "--porcelain", "--untracked-files=all"],
    { capture: true, trim: false },
  );
  const unexpected = status.split("\n").filter(Boolean).map(statusPath).filter((path) =>
    !allowedPaths.has(path)
  );
  if (unexpected.length > 0) {
    throw new Error(
      `Unexpected local changes in ${checkout.name}: ${unexpected.join(", ")}`,
    );
  }
}

async function checkArtifact(artifact: VendorArtifact & { resolvedPath: string }): Promise<void> {
  let stat: Deno.FileInfo;
  try {
    stat = await Deno.stat(artifact.resolvedPath);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(`Missing vendor artifact ${artifact.name}: ${artifact.resolvedPath}`);
    }
    throw error;
  }
  if (artifact.kind === "directory" && !stat.isDirectory) {
    throw new Error(
      `Vendor artifact ${artifact.name} is not a directory: ${artifact.resolvedPath}`,
    );
  }
  if (artifact.kind !== "directory" && !stat.isFile) {
    throw new Error(`Vendor artifact ${artifact.name} is not a file: ${artifact.resolvedPath}`);
  }
  if (artifact.kind === "executable" && (stat.mode === null || (stat.mode & 0o111) === 0)) {
    throw new Error(`Vendor artifact ${artifact.name} is not executable: ${artifact.resolvedPath}`);
  }
}

export async function checkVendorManifest(resolved: ResolvedVendorManifest): Promise<void> {
  for (const checkout of resolved.checkouts.values()) await checkCheckout(checkout);
  for (const artifact of resolved.artifacts.values()) await checkArtifact(artifact);
}

function resolvedSteps(
  resolved: ResolvedVendorManifest,
): Array<VendorStep & { run: string[]; cwd: string }> {
  const manifestRoot = dirname(resolved.sourcePath);
  const ownerRoot = basename(manifestRoot) === "vendors" ? dirname(manifestRoot) : manifestRoot;
  const variables = new Map<string, string>([
    ["root", ownerRoot],
    ["manifest", manifestRoot],
    ...[...resolved.checkouts].map(([name, checkout]) =>
      [`checkout.${name}`, checkout.resolvedPath] as [string, string]
    ),
  ]);
  return (resolved.manifest.steps ?? []).map((step) => ({
    ...step,
    run: step.run.map((part) => substitute(part, variables)),
    cwd: resolve(manifestRoot, substitute(step.cwd ?? "${root}", variables)),
    environment: step.environment
      ? Object.fromEntries(
        Object.entries(step.environment).map(([key, value]) => [key, substitute(value, variables)]),
      )
      : undefined,
  }));
}

async function applyVendorManifest(resolved: ResolvedVendorManifest): Promise<void> {
  for (const checkout of resolved.checkouts.values()) {
    if (!(await exists(`${checkout.resolvedPath}/.git`))) {
      if (await exists(checkout.resolvedPath)) {
        throw new Error(`${checkout.resolvedPath} exists but is not a Git checkout`);
      }
      await run(["git", "init", checkout.resolvedPath]);
      await run([
        "git",
        "-C",
        checkout.resolvedPath,
        "remote",
        "add",
        "origin",
        checkout.repository,
      ]);
      await run([
        "git",
        "-C",
        checkout.resolvedPath,
        "fetch",
        "--depth",
        "1",
        "origin",
        checkout.revision,
      ]);
      await run(["git", "-C", checkout.resolvedPath, "checkout", "--detach", "FETCH_HEAD"]);
    }
    const actual = await run(["git", "-C", checkout.resolvedPath, "rev-parse", "HEAD"], {
      capture: true,
    });
    if (actual !== checkout.revision) {
      throw new Error(`${checkout.name} is at ${actual}; expected ${checkout.revision}`);
    }
    for (const patch of checkout.resolvedPatches) {
      if (await patchApplied(checkout.resolvedPath, patch)) continue;
      await run(["git", "-C", checkout.resolvedPath, "apply", "--check", patch]);
      await run(["git", "-C", checkout.resolvedPath, "apply", patch]);
    }
  }
  for (const step of resolvedSteps(resolved)) {
    console.log(`Vendor step: ${step.name ?? step.run[0]}`);
    await run(step.run, { cwd: step.cwd, environment: step.environment });
  }
  await checkVendorManifest(resolved);
}

function printDryRun(resolved: ResolvedVendorManifest): void {
  for (const checkout of resolved.checkouts.values()) {
    console.log(`Checkout ${checkout.name}: ${checkout.repository}@${checkout.revision}`);
    if (checkout.upstream) console.log(`  upstream: ${checkout.upstream}`);
    console.log(`  target: ${checkout.resolvedPath}`);
    for (const patch of checkout.resolvedPatches) console.log(`  patch:  ${patch}`);
  }
  for (const step of resolvedSteps(resolved)) {
    console.log(`Step ${step.name ?? step.run[0]} (cwd ${step.cwd}):`);
    console.log(`  ${step.run.map(shellQuote).join(" ")}`);
  }
  for (const artifact of resolved.artifacts.values()) {
    console.log(`Artifact ${artifact.name} (${artifact.kind}): ${artifact.resolvedPath}`);
  }
}

export function vendorArtifact(resolved: ResolvedVendorManifest, name: string): string {
  const artifact = resolved.artifacts.get(name);
  if (!artifact) {
    throw new Error(`Vendor manifest ${resolved.manifest.name} has no artifact ${name}`);
  }
  return artifact.resolvedPath;
}

export async function vendorCommand(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(vendorUsage());
    return;
  }
  let manifestPath: string | undefined;
  let action: "apply" | "check" | "dry-run" = "apply";
  for (const arg of args) {
    if (arg === "--apply") action = "apply";
    else if (arg === "--check") action = "check";
    else if (arg === "--dry-run") action = "dry-run";
    else if (arg.startsWith("-")) throw new Error(`Unknown vendor option: ${arg}`);
    else if (manifestPath) throw new Error("Only one vendor manifest may be supplied");
    else manifestPath = arg;
  }
  if (!manifestPath) throw new Error(`A vendor manifest is required\n\n${vendorUsage()}`);
  const resolved = await loadVendorManifest(manifestPath);
  if (action === "dry-run") printDryRun(resolved);
  else if (action === "check") {
    await checkVendorManifest(resolved);
    console.log(`Valid vendor build: ${resolved.manifest.name}`);
  } else {
    await applyVendorManifest(resolved);
    console.log(`Vendor build ready: ${resolved.manifest.name}`);
  }
}
