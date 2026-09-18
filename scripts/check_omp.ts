import { dirname, fromFileUrl, join } from "jsr:@std/path@1";

const projectRoot = dirname(dirname(fromFileUrl(import.meta.url)));
const sourceRoot = join(projectRoot, "vendor", "omp");
const versionPath = join(projectRoot, "vendor", "omp.version");

const version = Object.fromEntries(
  (await Deno.readTextFile(versionPath)).trim().split("\n").map((line) => line.split("=", 2)),
);

async function output(command: string, args: string[], cwd?: string): Promise<string> {
  const result = await new Deno.Command(command, { args, cwd, stderr: "piped", stdout: "piped" })
    .output();
  if (!result.success) {
    throw new Error(new TextDecoder().decode(result.stderr).trim() || `${command} failed`);
  }
  return new TextDecoder().decode(result.stdout).trim();
}

const sourceCommit = await output("git", ["rev-parse", "HEAD"], sourceRoot);
if (sourceCommit !== version.commit) {
  throw new Error(`OMP source is ${sourceCommit}; expected pinned commit ${version.commit}`);
}

for (
  const path of [
    "packages/ai/src/auth-broker/index.ts",
    "packages/ai/src/auth-gateway/index.ts",
    "packages/coding-agent/src/cli/auth-broker-cli.ts",
    "packages/coding-agent/src/cli/auth-gateway-cli.ts",
  ]
) {
  await Deno.stat(join(sourceRoot, path));
}

const installedVersion = await output("omp", ["--version"]);
if (!installedVersion.endsWith(`/${version.package_version}`)) {
  throw new Error(`Installed ${installedVersion}; expected omp/${version.package_version}`);
}

console.log(`OMP ${version.package_version} source and executable match ${version.commit}`);
