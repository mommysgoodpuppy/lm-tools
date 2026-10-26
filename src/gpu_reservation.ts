import { listSystemProcesses, terminatePid } from "./process_manager.ts";

const PROJECT_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const DEFAULT_BASE_CONFIG = `${PROJECT_ROOT}/config/base.json`;
const DEFAULT_GRACE_SECONDS = 5;

// Backend executables recognized by name wherever they are installed, so ad hoc
// runs (for example a transient systemd-run deployment) are found too.
export const INFERENCE_EXECUTABLE_NAMES = ["llama-server", "hipfire"];

export interface Reservation {
  owner: string;
  pid?: number;
  reason?: string;
  createdAt: string;
}

export interface InferenceProcess {
  pid: number;
  executable: string;
  unit?: string;
}

interface ReservationConfig {
  resources?: {
    gpu?:
      | { mode: "shared" }
      | { mode: "exclusive"; conflictingExecutables: string[]; shutdownGraceSeconds: number };
  };
}

export function gpuUsage(): string {
  return `Usage: lm gpu <reserve|release|status> [options]

Reserve the GPU for another workload (such as VR): stop every running inference backend and make
lm deploy refuse to start until the reservation is released or its holder process exits.

Commands:
  reserve --owner NAME [--pid PID] [--reason TEXT]
                 Record a reservation and stop running inference. With --pid, the reservation
                 lapses automatically when that process exits.
  release --owner NAME
                 Remove the reservation. Stopped models are not restarted.
  status         List active reservations and running inference processes`;
}

export function reservationDir(): string {
  return `${Deno.env.get("XDG_RUNTIME_DIR") ?? "/tmp"}/lm-tools-gpu-reservations`;
}

function reservationPath(owner: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(owner)) throw new Error(`Invalid reservation owner: ${owner}`);
  return `${reservationDir()}/${owner}.json`;
}

/** The systemd unit owning a process, from the last path element of /proc/PID/cgroup. */
export function unitFromCgroup(cgroup: string): string | undefined {
  const line = cgroup.split("\n").find((entry) => entry.startsWith("0::"));
  const leaf = line?.slice(3).split("/").filter(Boolean).at(-1);
  return leaf && /\.(service|scope)$/.test(leaf) ? leaf : undefined;
}

/** Only services are stopped as units: a scope is usually a terminal or desktop app. */
export function stoppableUnit(unit: string | undefined): unit is string {
  return unit !== undefined && unit.endsWith(".service") && !unit.startsWith("user@");
}

export function isInferenceProcess(
  executable: string,
  cmdline: string[],
  configured: string[],
  inferenceDirs: Set<string>,
): boolean {
  const base = executable.split("/").at(-1) ?? "";
  if (INFERENCE_EXECUTABLE_NAMES.includes(base) || configured.includes(executable)) return true;
  // hipfire's model daemon lives beside the hipfire executable.
  if (base === "daemon" && inferenceDirs.has(executable.slice(0, -"/daemon".length))) return true;
  const deploy = cmdline.indexOf("deploy");
  return deploy > 0 && cmdline.slice(0, deploy).some((arg) => arg.endsWith("lm-tools/main.ts"));
}

export function reservationActive(reservation: Reservation, pidAlive: (pid: number) => boolean) {
  return reservation.pid === undefined || pidAlive(reservation.pid);
}

function pidAlive(pid: number): boolean {
  try {
    Deno.statSync(`/proc/${pid}`);
    return true;
  } catch {
    return false;
  }
}

export async function activeReservations(): Promise<Reservation[]> {
  const active: Reservation[] = [];
  try {
    for await (const entry of Deno.readDir(reservationDir())) {
      if (!entry.isFile || !entry.name.endsWith(".json")) continue;
      const path = `${reservationDir()}/${entry.name}`;
      const reservation = JSON.parse(await Deno.readTextFile(path)) as Reservation;
      if (reservationActive(reservation, pidAlive)) active.push(reservation);
      else await Deno.remove(path).catch(() => {});
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return active;
}

/** Throws unless the GPU is free of reservations; deploy calls this before loading a model. */
export async function requireNoGpuReservation(): Promise<void> {
  const active = await activeReservations();
  if (active.length === 0) return;
  const holders = active.map((r) => `${r.owner}${r.pid ? ` (pid ${r.pid})` : ""}`).join(", ");
  throw new Error(`GPU is reserved by ${holders}; use --force to deploy anyway`);
}

async function loadConfig(): Promise<{ configured: string[]; graceMs: number }> {
  const path = Deno.env.get("LM_TOOLS_BASE_CONFIG") ?? DEFAULT_BASE_CONFIG;
  const config = JSON.parse(await Deno.readTextFile(path)) as ReservationConfig;
  const gpu = config.resources?.gpu;
  return gpu?.mode === "exclusive"
    ? { configured: gpu.conflictingExecutables, graceMs: gpu.shutdownGraceSeconds * 1000 }
    : { configured: [], graceMs: DEFAULT_GRACE_SECONDS * 1000 };
}

export async function findInferenceProcesses(configured: string[]): Promise<InferenceProcess[]> {
  const processes = (await listSystemProcesses()).filter((p) => p.pid !== Deno.pid);
  const inferenceDirs = new Set(
    processes
      .filter((p) => INFERENCE_EXECUTABLE_NAMES.includes(p.executable.split("/").at(-1) ?? ""))
      .map((p) => p.executable.slice(0, p.executable.lastIndexOf("/"))),
  );
  const found: InferenceProcess[] = [];
  for (const process of processes) {
    let cmdline: string[];
    let cgroup: string;
    try {
      cmdline = (await Deno.readTextFile(`/proc/${process.pid}/cmdline`)).split("\0");
      cgroup = await Deno.readTextFile(`/proc/${process.pid}/cgroup`);
    } catch {
      continue;
    }
    if (isInferenceProcess(process.executable, cmdline, configured, inferenceDirs)) {
      found.push({ ...process, unit: unitFromCgroup(cgroup) });
    }
  }
  return found;
}

export async function stopInference(configured: string[], graceMs: number): Promise<string[]> {
  const stopped: string[] = [];
  const processes = await findInferenceProcesses(configured);
  const units = [...new Set(processes.map((p) => p.unit).filter(stoppableUnit))];
  if (units.length > 0) {
    const status = await new Deno.Command("/usr/bin/systemctl", {
      args: ["--user", "stop", ...units],
      stdin: "null",
    }).spawn().status;
    if (!status.success) throw new Error(`Could not stop user units ${units.join(", ")}`);
    stopped.push(...units.map((unit) => `unit ${unit}`));
  }
  for (const process of await findInferenceProcesses(configured)) {
    const outcome = await terminatePid(process.pid, graceMs);
    stopped.push(`process ${process.pid} (${process.executable}, ${outcome})`);
  }
  return stopped;
}

function parseOptions(args: string[]): Record<string, string> {
  const options: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const [key, value] = [args[i], args[i + 1]];
    if (!["--owner", "--pid", "--reason"].includes(key) || value === undefined) {
      throw new Error(`Unknown or incomplete gpu option: ${key}\n\n${gpuUsage()}`);
    }
    options[key.slice(2)] = value;
  }
  return options;
}

export async function gpuCommand(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (!sub || sub === "--help" || sub === "-h") {
    console.log(gpuUsage());
    return;
  }
  if (sub === "status") {
    for (const r of await activeReservations()) {
      console.log(`reserved by ${r.owner}${r.pid ? ` pid ${r.pid}` : ""} since ${r.createdAt}`);
    }
    const { configured } = await loadConfig();
    for (const p of await findInferenceProcesses(configured)) {
      console.log(`inference ${p.pid} ${p.executable}${p.unit ? ` [${p.unit}]` : ""}`);
    }
    return;
  }
  const options = parseOptions(rest);
  if (!options.owner) throw new Error(`--owner is required\n\n${gpuUsage()}`);
  const path = reservationPath(options.owner);
  if (sub === "release") {
    await Deno.remove(path).catch((error) => {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    });
    console.log(`Released GPU reservation for ${options.owner}`);
    return;
  }
  if (sub !== "reserve") throw new Error(`Unknown gpu command: ${sub}\n\n${gpuUsage()}`);
  const pid = options.pid === undefined ? undefined : Number(options.pid);
  if (pid !== undefined && !(Number.isInteger(pid) && pid > 0)) {
    throw new Error(`Invalid --pid: ${options.pid}`);
  }
  const reservation: Reservation = {
    owner: options.owner,
    ...(pid ? { pid } : {}),
    ...(options.reason ? { reason: options.reason } : {}),
    createdAt: new Date().toISOString(),
  };
  await Deno.mkdir(reservationDir(), { recursive: true, mode: 0o700 });
  await Deno.writeTextFile(path, JSON.stringify(reservation));
  const { configured, graceMs } = await loadConfig();
  const stopped = await stopInference(configured, graceMs);
  console.log(`Reserved GPU for ${options.owner}${pid ? ` (pid ${pid})` : ""}`);
  for (const entry of stopped) console.log(`Stopped ${entry}`);
}
