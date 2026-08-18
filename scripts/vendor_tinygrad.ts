import { dirname, fromFileUrl, join } from "jsr:@std/path@1";

const projectRoot = dirname(dirname(fromFileUrl(import.meta.url)));
const versionFile = join(projectRoot, "vendor", "tinygrad.version");
const target = join(projectRoot, "vendor", "tinygrad");
const patch = join(projectRoot, "patches", "tinygrad-recurrent-chunk.patch");

const metadata = Object.fromEntries(
  (await Deno.readTextFile(versionFile)).trim().split("\n").map((line) => line.split("=", 2)),
);
const repository = metadata.repository;
const commit = metadata.commit;
if (!repository || !commit) throw new Error(`${versionFile} must define repository and commit`);

try {
  await Deno.stat(target);
  throw new Error(`${target} already exists; refusing to overwrite a local tinygrad checkout`);
} catch (error) {
  if (!(error instanceof Deno.errors.NotFound)) throw error;
}

async function run(command: string, args: string[]): Promise<void> {
  const status = await new Deno.Command(command, {
    args,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn().status;
  if (!status.success) throw new Error(`${command} exited with status ${status.code}`);
}

await run("git", ["init", target]);
await run("git", ["-C", target, "remote", "add", "origin", repository]);
await run("git", ["-C", target, "fetch", "--depth", "1", "origin", commit]);
await run("git", ["-C", target, "checkout", "--detach", "FETCH_HEAD"]);
await run("git", ["-C", target, "apply", patch]);

console.log(`tinygrad ${commit} is ready in ${target}`);
