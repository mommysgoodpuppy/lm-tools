export interface SystemProcess {
  pid: number;
  executable: string;
}

export function matchingProcesses(
  processes: SystemProcess[],
  executables: string[],
  ownPid = Deno.pid,
): SystemProcess[] {
  const conflicts = new Set(executables);
  return processes.filter((process) => process.pid !== ownPid && conflicts.has(process.executable));
}

export async function listSystemProcesses(): Promise<SystemProcess[]> {
  const processes: SystemProcess[] = [];
  for await (const entry of Deno.readDir("/proc")) {
    if (!entry.isDirectory || !/^\d+$/.test(entry.name)) continue;
    const pid = Number(entry.name);
    try {
      processes.push({ pid, executable: await Deno.realPath(`/proc/${pid}/exe`) });
    } catch {
      continue;
    }
  }
  return processes;
}

async function processExists(pid: number): Promise<boolean> {
  try {
    await Deno.stat(`/proc/${pid}`);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (!(await processExists(pid))) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !(await processExists(pid));
}

export async function terminatePid(pid: number, graceMs: number): Promise<"terminated" | "killed"> {
  if (!(await processExists(pid))) return "terminated";
  Deno.kill(pid, "SIGTERM");
  if (await waitForExit(pid, graceMs)) return "terminated";
  Deno.kill(pid, "SIGKILL");
  if (!(await waitForExit(pid, graceMs))) throw new Error(`Process ${pid} survived SIGKILL`);
  return "killed";
}

export async function terminateChild(
  child: Deno.ChildProcess,
  graceMs: number,
  processGroup = false,
): Promise<"exited" | "terminated" | "killed"> {
  const status = await Promise.race([
    child.status.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 0)),
  ]);
  if (status) return "exited";
  const signal = (name: Deno.Signal) => {
    try {
      if (processGroup) Deno.kill(-child.pid, name);
      else child.kill(name);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  };
  signal("SIGTERM");
  const graceful = await Promise.race([
    child.status.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), graceMs)),
  ]);
  if (graceful) return "terminated";
  signal("SIGKILL");
  await child.status;
  return "killed";
}

export function vramAdmission(
  totalBytes: number,
  usedBytes: number,
  expectedVramMiB: number,
  minimumRemainingMiB: number,
): { freeBytes: number; requiredBytes: number; accepted: boolean } {
  const freeBytes = totalBytes - usedBytes;
  const requiredBytes = (expectedVramMiB + minimumRemainingMiB) * 1024 * 1024;
  return { freeBytes, requiredBytes, accepted: freeBytes >= requiredBytes };
}

export async function requireModelVram(
  devicePath: string,
  expectedVramMiB: number,
  minimumRemainingMiB: number,
): Promise<void> {
  const [total, used] = await Promise.all([
    Deno.readTextFile(`${devicePath}/mem_info_vram_total`).then((value) => Number(value.trim())),
    Deno.readTextFile(`${devicePath}/mem_info_vram_used`).then((value) => Number(value.trim())),
  ]);
  const admission = vramAdmission(total, used, expectedVramMiB, minimumRemainingMiB);
  if (!admission.accepted) {
    const mib = (bytes: number) => Math.floor(bytes / 1024 / 1024);
    throw new Error(
      `Insufficient dedicated VRAM: ${mib(admission.freeBytes)} MiB free, ` +
        `${mib(admission.requiredBytes)} MiB required for expected model use and safety reserve`,
    );
  }
}

export async function acquireExclusiveLease(
  path: string,
  graceMs: number,
): Promise<() => Promise<void>> {
  while (true) {
    try {
      const file = await Deno.open(path, { write: true, createNew: true });
      await file.write(new TextEncoder().encode(String(Deno.pid)));
      file.close();
      return async () => {
        const owner = await Deno.readTextFile(path).catch(() => "");
        if (owner.trim() === String(Deno.pid)) await Deno.remove(path);
      };
    } catch (error) {
      if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
      const owner = Number((await Deno.readTextFile(path).catch(() => "0")).trim());
      if (owner > 0 && owner !== Deno.pid && await processExists(owner)) {
        await terminatePid(owner, graceMs);
      }
      await Deno.remove(path).catch((removeError) => {
        if (!(removeError instanceof Deno.errors.NotFound)) throw removeError;
      });
    }
  }
}

export async function evictConflictingProcesses(
  executables: string[],
  graceMs: number,
): Promise<Array<SystemProcess & { outcome: "terminated" | "killed" }>> {
  const conflicts = matchingProcesses(await listSystemProcesses(), executables);
  const outcomes = [];
  for (const process of conflicts) {
    outcomes.push({ ...process, outcome: await terminatePid(process.pid, graceMs) });
  }
  return outcomes;
}
