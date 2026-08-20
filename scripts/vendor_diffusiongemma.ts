import { dirname, fromFileUrl, join } from "jsr:@std/path@1";

const projectRoot = dirname(dirname(fromFileUrl(import.meta.url)));
const versionFile = join(projectRoot, "vendor", "diffusiongemma.version");
const frontendTarget = join(projectRoot, "vendor", "diffusiongemma-lab");
const llamaTarget = join(projectRoot, "vendor", "llama.cpp-diffusiongemma");
const buildTarget = join(llamaTarget, "build-vulkan");
const localFrontendPatch = join(projectRoot, "patches", "diffusiongemma-lab-local.patch");

const metadata = Object.fromEntries(
  (await Deno.readTextFile(versionFile)).trim().split("\n").map((line) => line.split("=", 2)),
);

for (
  const key of ["frontend_repository", "frontend_commit", "llama_repository", "llama_commit"]
) {
  if (!metadata[key]) throw new Error(`${versionFile} must define ${key}`);
}

async function run(
  command: string,
  args: string[],
  options: { cwd?: string; capture?: boolean } = {},
): Promise<string> {
  const output = await new Deno.Command(command, {
    args,
    cwd: options.cwd,
    stdin: "inherit",
    stdout: options.capture ? "piped" : "inherit",
    stderr: "inherit",
  }).output();
  if (!output.success) throw new Error(`${command} exited with status ${output.code}`);
  return options.capture ? new TextDecoder().decode(output.stdout).trim() : "";
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

async function ensurePinnedCheckout(
  repository: string,
  commit: string,
  target: string,
): Promise<void> {
  if (!(await exists(join(target, ".git")))) {
    if (await exists(target)) throw new Error(`${target} exists but is not a Git checkout`);
    await run("git", ["init", target]);
    await run("git", ["-C", target, "remote", "add", "origin", repository]);
    await run("git", ["-C", target, "fetch", "--depth", "1", "origin", commit]);
    await run("git", ["-C", target, "checkout", "--detach", "FETCH_HEAD"]);
  }
  const actual = await run("git", ["-C", target, "rev-parse", "HEAD"], { capture: true });
  if (actual !== commit) {
    throw new Error(`${target} is at ${actual}; expected pinned commit ${commit}`);
  }
}

async function applyPatch(target: string, patch: string): Promise<void> {
  const check = await new Deno.Command("git", {
    args: ["-C", target, "apply", "--check", patch],
    stdout: "null",
    stderr: "null",
  }).output();
  if (check.success) {
    await run("git", ["-C", target, "apply", patch]);
    return;
  }
  const reverseCheck = await new Deno.Command("git", {
    args: ["-C", target, "apply", "--reverse", "--check", patch],
    stdout: "null",
    stderr: "null",
  }).output();
  if (!reverseCheck.success) throw new Error(`Could not apply ${patch}`);
}

await ensurePinnedCheckout(
  metadata.frontend_repository,
  metadata.frontend_commit,
  frontendTarget,
);
await ensurePinnedCheckout(metadata.llama_repository, metadata.llama_commit, llamaTarget);

await applyPatch(frontendTarget, localFrontendPatch);

const frontendPatch = join(frontendTarget, "patches", "diffusion-cli.patch");
await applyPatch(llamaTarget, frontendPatch);

await run("npm", ["ci"], { cwd: frontendTarget });
await run("cmake", [
  "-S",
  llamaTarget,
  "-B",
  buildTarget,
  "-G",
  "Ninja",
  "-DCMAKE_BUILD_TYPE=Release",
  "-DGGML_VULKAN=ON",
  "-DGGML_NATIVE=ON",
  "-DLLAMA_CURL=OFF",
]);
await run("cmake", ["--build", buildTarget, "--target", "llama-diffusion-cli", "-j"]);

const binary = join(buildTarget, "bin", "llama-diffusion-cli");
if (!(await exists(binary))) throw new Error(`Build completed without ${binary}`);
console.log(`DiffusionGemma Vulkan runner is ready: ${binary}`);
console.log(`Frontend is ready: ${frontendTarget}`);
