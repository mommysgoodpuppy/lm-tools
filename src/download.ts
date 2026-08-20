import { parsePositiveInteger, takeValue } from "./args.ts";
import { dirname } from "node:path";
import { createHash } from "node:crypto";

export interface DownloadFileOptions {
  url: URL;
  output: string;
  connections: number;
  chunkBytes: number;
  expectedSize?: number;
  sha256?: string;
}

interface RemoteFile {
  size: number;
  etag: string;
  lastModified: string;
}

interface DownloadState extends RemoteFile {
  url: string;
  chunkBytes: number;
  completed: number[];
}

export interface Chunk {
  start: number;
  end: number;
}

export function downloadUsage(): string {
  return `Usage: lm download URL OUTPUT [options]

Options:
  --connections N  Parallel requests (default: 16 for Hugging Face, otherwise 8)
  --chunk-mib N    Chunk size in MiB (default: 64)
  --help           Show this help

Downloads to OUTPUT.part and records resumable state in OUTPUT.part.json.`;
}

export function planChunks(size: number, chunkBytes: number): Chunk[] {
  const chunks: Chunk[] = [];
  for (let start = 0; start < size; start += chunkBytes) {
    chunks.push({ start, end: Math.min(start + chunkBytes, size) - 1 });
  }
  return chunks;
}

export function recommendedConnections(url: URL): number {
  return url.hostname === "huggingface.co" || url.hostname.endsWith(".huggingface.co") ? 16 : 8;
}

function parseDownloadArgs(args: string[]): DownloadFileOptions {
  if (args.includes("--help") || args.includes("-h")) throw new DownloadHelp(downloadUsage());
  const positional: string[] = [];
  let connections: number | undefined;
  let chunkMib = 64;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith("-")) {
      positional.push(arg);
      continue;
    }
    const value = takeValue(args, index, arg);
    index++;
    if (arg === "--connections") connections = parsePositiveInteger(value, arg);
    else if (arg === "--chunk-mib") chunkMib = parsePositiveInteger(value, arg);
    else throw new Error(`Unknown download option: ${arg}`);
  }
  if (positional.length !== 2) throw new Error(downloadUsage());
  const url = new URL(positional[0]);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("URL must use http: or https:");
  return {
    url,
    output: positional[1],
    connections: connections ?? recommendedConnections(url),
    chunkBytes: chunkMib * 1024 * 1024,
  };
}

class DownloadHelp extends Error {}

async function inspectRemote(url: URL): Promise<RemoteFile> {
  let response = await fetch(url, { method: "HEAD", redirect: "follow" });
  if (!response.ok || response.headers.get("content-length") === null) {
    await response.body?.cancel();
    response = await fetch(url, { headers: { range: "bytes=0-0" }, redirect: "follow" });
  }
  if (!response.ok) throw new Error(`Could not inspect download: HTTP ${response.status}`);
  const contentRange = response.headers.get("content-range");
  const sizeText = contentRange?.match(/\/(\d+)$/)?.[1] ?? response.headers.get("content-length");
  const size = Number(sizeText);
  const acceptsRanges = response.status === 206 ||
    response.headers.get("accept-ranges")?.toLowerCase().includes("bytes");
  await response.body?.cancel();
  if (!Number.isSafeInteger(size) || size < 1) {
    throw new Error("Server did not provide a file size");
  }
  if (!acceptsRanges) throw new Error("Server does not support byte-range downloads");
  return {
    size,
    etag: response.headers.get("etag") ?? "",
    lastModified: response.headers.get("last-modified") ?? "",
  };
}

function sameRemote(
  state: DownloadState,
  options: DownloadFileOptions,
  remote: RemoteFile,
): boolean {
  return state.url === options.url.href && state.size === remote.size &&
    state.etag === remote.etag && state.lastModified === remote.lastModified &&
    state.chunkBytes === options.chunkBytes;
}

async function writeState(path: string, state: DownloadState): Promise<void> {
  const temporary = `${path}.tmp`;
  await Deno.writeTextFile(temporary, `${JSON.stringify(state)}\n`);
  await Deno.rename(temporary, path);
}

async function downloadChunk(
  url: URL,
  partialPath: string,
  chunk: Chunk,
  signal: AbortSignal,
): Promise<number> {
  const expected = chunk.end - chunk.start + 1;
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { range: `bytes=${chunk.start}-${chunk.end}` },
        redirect: "follow",
        signal,
      });
      if (response.status !== 206 || !response.body) {
        throw new Error(`expected HTTP 206, got ${response.status}`);
      }
      const file = await Deno.open(partialPath, { write: true });
      let received = 0;
      try {
        await file.seek(chunk.start, Deno.SeekMode.Start);
        for await (const block of response.body) {
          let offset = 0;
          while (offset < block.length) offset += await file.write(block.subarray(offset));
          received += block.length;
        }
        await file.syncData();
      } finally {
        file.close();
      }
      if (received !== expected) {
        throw new Error(`short chunk: expected ${expected}, got ${received}`);
      }
      return received;
    } catch (error) {
      if (signal.aborted || attempt === 8) throw error;
      console.warn(`chunk ${chunk.start}-${chunk.end}, attempt ${attempt} failed; retrying`);
      await new Promise((resolve) => setTimeout(resolve, Math.min(2 ** attempt, 20) * 1000));
    }
  }
  throw new Error("unreachable");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

export async function downloadCommand(args: string[]): Promise<void> {
  let options: DownloadFileOptions;
  try {
    options = parseDownloadArgs(args);
  } catch (error) {
    if (error instanceof DownloadHelp) {
      console.log(error.message);
      return;
    }
    throw error;
  }
  await downloadFile(options);
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  const file = await Deno.open(path, { read: true });
  try {
    for await (const chunk of file.readable) hash.update(chunk);
  } finally {
    try {
      file.close();
    } catch {
      // Consuming the readable stream normally closes the file.
    }
  }
  return hash.digest("hex");
}

export async function verifyFileIntegrity(
  path: string,
  expectedSize?: number,
  expectedSha256?: string,
): Promise<void> {
  const info = await Deno.stat(path);
  if (!info.isFile) throw new Error(`Artifact is not a file: ${path}`);
  if (expectedSize !== undefined && info.size !== expectedSize) {
    throw new Error(
      `Artifact size mismatch for ${path}: expected ${expectedSize}, got ${info.size}`,
    );
  }
  if (expectedSha256 !== undefined) {
    const actual = await sha256File(path);
    if (actual !== expectedSha256.toLowerCase()) {
      throw new Error(
        `Artifact SHA-256 mismatch for ${path}: expected ${expectedSha256}, got ${actual}`,
      );
    }
  }
}

export async function downloadFile(options: DownloadFileOptions): Promise<void> {
  if (await pathExists(options.output)) throw new Error(`Output already exists: ${options.output}`);
  const remote = await inspectRemote(options.url);
  if (options.expectedSize !== undefined && remote.size !== options.expectedSize) {
    throw new Error(
      `Remote size mismatch: expected ${options.expectedSize}, server reports ${remote.size}`,
    );
  }
  const partialPath = `${options.output}.part`;
  const statePath = `${partialPath}.json`;
  const outputDirectory = dirname(options.output);
  if (outputDirectory !== ".") await Deno.mkdir(outputDirectory, { recursive: true });

  let state: DownloadState;
  if (await pathExists(partialPath) || await pathExists(statePath)) {
    if (!(await pathExists(partialPath)) || !(await pathExists(statePath))) {
      throw new Error(`Incomplete resume pair; inspect ${partialPath} and ${statePath}`);
    }
    state = JSON.parse(await Deno.readTextFile(statePath)) as DownloadState;
    if (!sameRemote(state, options, remote)) {
      throw new Error(`Resume metadata no longer matches; inspect ${partialPath} and ${statePath}`);
    }
  } else {
    const file = await Deno.open(partialPath, { createNew: true, write: true });
    try {
      await file.truncate(remote.size);
    } finally {
      file.close();
    }
    state = { ...remote, url: options.url.href, chunkBytes: options.chunkBytes, completed: [] };
    await writeState(statePath, state);
  }

  const chunks = planChunks(remote.size, options.chunkBytes);
  const completed = new Set(state.completed);
  const pending = chunks.map((chunk, index) => ({ chunk, index })).filter(({ index }) =>
    !completed.has(index)
  );
  const initiallyDone = [...completed].reduce(
    (total, index) => total + (chunks[index]?.end ?? -1) - (chunks[index]?.start ?? 0) + 1,
    0,
  );
  let doneBytes = initiallyDone;
  const started = performance.now();
  let stateWrites = Promise.resolve();
  const controller = new AbortController();
  const abort = () => controller.abort();
  Deno.addSignalListener("SIGINT", abort);
  Deno.addSignalListener("SIGTERM", abort);

  try {
    let cursor = 0;
    const worker = async () => {
      while (cursor < pending.length) {
        const current = pending[cursor++];
        const received = await downloadChunk(
          options.url,
          partialPath,
          current.chunk,
          controller.signal,
        );
        completed.add(current.index);
        doneBytes += received;
        const completedBytes = doneBytes;
        state.completed = [...completed].sort((a, b) => a - b);
        stateWrites = stateWrites.then(() => writeState(statePath, state));
        await stateWrites;
        const seconds = Math.max((performance.now() - started) / 1000, 0.001);
        const speed = (completedBytes - initiallyDone) / seconds;
        console.log(
          `${(completedBytes / remote.size * 100).toFixed(2).padStart(6)}%  ` +
            `${(completedBytes / 1e9).toFixed(2)}/${(remote.size / 1e9).toFixed(2)} GB  ` +
            `${(speed / 1e6).toFixed(1)} MB/s`,
        );
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(options.connections, pending.length) }, worker),
    );
    await stateWrites;
  } finally {
    Deno.removeSignalListener("SIGINT", abort);
    Deno.removeSignalListener("SIGTERM", abort);
  }

  if (completed.size !== chunks.length) throw new Error("Download incomplete; rerun to resume");
  try {
    await verifyFileIntegrity(partialPath, options.expectedSize, options.sha256);
  } catch (error) {
    state.completed = [];
    await writeState(statePath, state);
    throw new Error(
      `${error instanceof Error ? error.message : error}; chunk state was reset, rerun to repair`,
    );
  }
  await Deno.rename(partialPath, options.output);
  await Deno.remove(statePath);
  console.log(`Complete: ${options.output} (${(remote.size / 1e9).toFixed(2)} GB)`);
}
