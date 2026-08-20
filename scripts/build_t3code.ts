import { dirname, fromFileUrl, join } from "jsr:@std/path@1";

const projectRoot = dirname(dirname(fromFileUrl(import.meta.url)));
const target = join(projectRoot, "vendor", "t3code");

async function run(
  command: string,
  args: string[],
  cwd = target,
  env?: Record<string, string>,
): Promise<void> {
  const output = await new Deno.Command(command, {
    args,
    cwd,
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (!output.success) throw new Error(`${command} exited with status ${output.code}`);
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

if (!(await exists(join(target, "package.json")))) {
  throw new Error(
    `Vendored T3 source is missing from ${target}; run: git submodule update --init vendor/t3code`,
  );
}

await run("corepack", ["pnpm@11.10.0", "install", "--frozen-lockfile", "--ignore-scripts"]);
await run(
  "corepack",
  ["pnpm@11.10.0", "--filter", "@t3tools/web", "build"],
  target,
  { VITE_LM_TOOLS_OBSERVER_ONLY: "1" },
);
await run("corepack", ["pnpm@11.10.0", "--filter", "t3", "build:bundle"]);
const artifacts = [
  join(target, "apps", "server", "dist", "bin.mjs"),
  join(target, "apps", "web", "dist", "index.html"),
];
for (const artifact of artifacts) {
  if (!(await exists(artifact))) throw new Error(`Build completed without ${artifact}`);
}
console.log(`lm-tools observer build is ready in ${target}`);
