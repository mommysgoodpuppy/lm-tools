import { dirname } from "jsr:@std/path@1";

const PROJECT_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

export class DiagnosticLog {
  readonly path: string;
  readonly requestDirectory: string;
  #pending: Promise<void> = Promise.resolve();

  constructor(path = `${PROJECT_ROOT}/logs/lm-tools.jsonl`) {
    this.path = path;
    this.requestDirectory = `${dirname(path)}/requests`;
  }

  log(source: string, event: string, details: Record<string, unknown> = {}): void {
    const line =
      JSON.stringify({ timestamp: new Date().toISOString(), source, event, ...details }) +
      "\n";
    this.#pending = this.#pending.then(async () => {
      await Deno.mkdir(dirname(this.path), { recursive: true });
      await Deno.writeTextFile(this.path, line, { append: true, create: true });
    }).catch((error) => console.error(`Could not write diagnostic log ${this.path}:`, error));
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
