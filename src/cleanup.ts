import { evictConflictingProcesses } from "./process_manager.ts";

const PROJECT_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const DEFAULT_BASE_CONFIG = `${PROJECT_ROOT}/config/base.json`;

interface CleanupConfig {
  emergencyStop: {
    userUnits: string[];
    tailscaleServe: { executable: string; httpsPorts: number[] };
  };
  resources: {
    gpu:
      | { mode: "shared" }
      | { mode: "exclusive"; conflictingExecutables: string[]; shutdownGraceSeconds: number };
  };
}

export function killEverythingUsage(): string {
  return `Usage: lm kill-everything

Stop configured lm-tools user services, terminate inference processes, and remove tailnet exposure.`;
}

export function userUnitStopArgs(units: string[]): string[] {
  return ["--user", "stop", ...units];
}

export async function killEverythingCommand(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(killEverythingUsage());
    return;
  }
  if (args.length > 0) throw new Error(`Unknown kill-everything option: ${args[0]}`);

  const baseConfigPath = Deno.env.get("LM_TOOLS_BASE_CONFIG") ?? DEFAULT_BASE_CONFIG;
  const config = JSON.parse(await Deno.readTextFile(baseConfigPath)) as CleanupConfig;
  const units = config.emergencyStop.userUnits;
  if (units.length > 0) {
    const status = await new Deno.Command("/usr/bin/systemctl", {
      args: userUnitStopArgs(units),
      stdin: "null",
      stdout: "inherit",
      stderr: "inherit",
    }).spawn().status;
    if (!status.success) throw new Error(`Could not stop configured user units (${status.code})`);
    console.log(`Stopped user units: ${units.join(", ")}`);
  }

  const gpu = config.resources.gpu;
  if (gpu.mode === "exclusive") {
    const evicted = await evictConflictingProcesses(
      gpu.conflictingExecutables,
      gpu.shutdownGraceSeconds * 1000,
    );
    for (const process of evicted) {
      console.log(`Stopped process ${process.pid} (${process.executable}, ${process.outcome})`);
    }
  }

  const tailscale = config.emergencyStop.tailscaleServe;
  for (const port of tailscale.httpsPorts) {
    const output = await new Deno.Command(tailscale.executable, {
      args: ["serve", `--https=${port}`, "off"],
      stdout: "null",
      stderr: "piped",
    }).output();
    if (output.success) console.log(`Disabled Tailscale Serve HTTPS port ${port}`);
  }

  const lease = `${Deno.env.get("XDG_RUNTIME_DIR") ?? "/tmp"}/lm-tools-gpu-exclusive.lock`;
  await Deno.remove(lease).catch((error) => {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  });
  console.log("All configured lm-tools model services are stopped");
}
