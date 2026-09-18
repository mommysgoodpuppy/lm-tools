import { dirname } from "jsr:@std/path@1";

const PROJECT_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

export const MAXIMUM_TEXT_LOG_BYTES = 2 * 1024 * 1024 * 1024;
export const TEXT_LOG_CAPACITY_EXIT_CODE = 78;

export class TextLogCapacityError extends Error {
  readonly exitCode = TEXT_LOG_CAPACITY_EXIT_CODE;

  constructor(readonly path: string, readonly maximumBytes: number) {
    super(`Text log capacity reached (${maximumBytes} bytes): ${path}`);
    this.name = "TextLogCapacityError";
  }
}

export interface AppendOnlyTextLogOptions {
  maximumBytes?: number;
  mode?: number;
  onCapacityExceeded?: (error: TextLogCapacityError) => void;
}

/** Append-only text storage with a hard ceiling and no implicit rotation or deletion. */
export class AppendOnlyTextLog {
  readonly path: string;
  readonly maximumBytes: number;
  #bytes: number;
  #pending: Promise<void> = Promise.resolve();
  readonly #mode: number;
  readonly #onCapacityExceeded: (error: TextLogCapacityError) => void;

  constructor(path: string, options: AppendOnlyTextLogOptions = {}) {
    this.path = path;
    this.maximumBytes = options.maximumBytes ?? MAXIMUM_TEXT_LOG_BYTES;
    this.#mode = options.mode ?? 0o600;
    this.#onCapacityExceeded = options.onCapacityExceeded ?? ((error) => {
      console.error(error.message);
      Deno.exit(error.exitCode);
    });
    try {
      this.#bytes = Deno.statSync(path).size;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      this.#bytes = 0;
    }
    if (this.#bytes >= this.maximumBytes) {
      throw new TextLogCapacityError(this.path, this.maximumBytes);
    }
  }

  get bytes(): number {
    return this.#bytes;
  }

  append(text: string): Promise<void> {
    const encoded = new TextEncoder().encode(text);
    this.#pending = this.#pending.then(async () => {
      if (this.#bytes + encoded.byteLength > this.maximumBytes) {
        const error = new TextLogCapacityError(this.path, this.maximumBytes);
        this.#onCapacityExceeded(error);
        throw error;
      }
      await Deno.mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      await Deno.writeFile(this.path, encoded, {
        append: true,
        create: true,
        mode: this.#mode,
      });
      await Deno.chmod(this.path, this.#mode);
      this.#bytes += encoded.byteLength;
    });
    return this.#pending;
  }

  async flush(): Promise<void> {
    await this.#pending;
  }
}

export class DiagnosticLog {
  readonly path: string;
  readonly requestDirectory: string;
  readonly #textLog: AppendOnlyTextLog;
  #pending: Promise<void> = Promise.resolve();

  constructor(
    path = `${PROJECT_ROOT}/logs/lm-tools.jsonl`,
    options: AppendOnlyTextLogOptions = {},
  ) {
    this.path = path;
    this.requestDirectory = `${dirname(path)}/requests`;
    this.#textLog = new AppendOnlyTextLog(path, options);
  }

  log(source: string, event: string, details: Record<string, unknown> = {}): void {
    const line =
      JSON.stringify({ timestamp: new Date().toISOString(), source, event, ...details }) +
      "\n";
    this.#pending = this.#pending.then(() => this.#textLog.append(line)).catch((error) => {
      if (error instanceof TextLogCapacityError) throw error;
      console.error(`Could not write diagnostic log ${this.path}:`, error);
    });
  }

  async flush(): Promise<void> {
    await this.#pending;
  }

  async captureRequest(requestId: string, body: ArrayBuffer): Promise<string> {
    const timestamp = new Date().toISOString();
    const safeRequestId = requestId.replaceAll(/[^a-zA-Z0-9._-]/g, "_").slice(0, 96) || "request";
    const suffix = crypto.randomUUID().slice(0, 8);
    const filename = `${timestamp.replaceAll(":", "-")}-${safeRequestId}-${suffix}.json`;
    const path = `${this.requestDirectory}/${filename}`;
    this.#pending = this.#pending.then(async () => {
      await Deno.mkdir(this.requestDirectory, { recursive: true });
      await Deno.writeFile(path, new Uint8Array(body));
    }).catch((error) => console.error(`Could not capture request ${path}:`, error));
    await this.#pending;
    return path;
  }
}

export function defaultDiagnosticLog(): DiagnosticLog {
  return new DiagnosticLog(Deno.env.get("LM_TOOLS_LOG") || undefined);
}
