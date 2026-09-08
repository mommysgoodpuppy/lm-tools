import { join } from "jsr:@std/path@1";
import type { ResolvedAgentEnvironment } from "./agent_environment.ts";

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await Deno.readTextFile(path)) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound || error instanceof SyntaxError) return null;
    throw error;
  }
}

interface EventTail {
  activity: string[];
  bytes: number | null;
  modifiedAt: string | null;
  ageSeconds: number | null;
  eventsInWindow: number;
  lastEventType: string | null;
  commandsStarted: number;
  commandsCompleted: number;
  commandsFailed: number;
}

const EMPTY_TAIL: EventTail = {
  activity: [],
  bytes: null,
  modifiedAt: null,
  ageSeconds: null,
  eventsInWindow: 0,
  lastEventType: null,
  commandsStarted: 0,
  commandsCompleted: 0,
  commandsFailed: 0,
};

async function recentEvents(path: string | undefined): Promise<EventTail> {
  if (!path) return EMPTY_TAIL;
  let file: Deno.FsFile;
  try {
    file = await Deno.open(path, { read: true });
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return EMPTY_TAIL;
    throw error;
  }
  try {
    const stat = await file.stat();
    const length = Math.min(stat.size, 512 * 1024);
    const offset = stat.size - length;
    await file.seek(offset, Deno.SeekMode.Start);
    const bytes = new Uint8Array(length);
    const count = await file.read(bytes) ?? 0;
    const lines = new TextDecoder().decode(bytes.subarray(0, count)).split("\n");
    if (offset > 0) lines.shift();
    const activity: string[] = [];
    let eventsInWindow = 0;
    let lastEventType: string | null = null;
    let commandsStarted = 0;
    let commandsCompleted = 0;
    let commandsFailed = 0;
    for (const line of lines) {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      eventsInWindow += 1;
      lastEventType = typeof event.type === "string" ? event.type : "unknown";
      if (event.type !== "item.completed" && event.type !== "item.started") continue;
      const item = event.item as Record<string, unknown> | undefined;
      if (item?.type === "agent_message" && typeof item.text === "string") {
        activity.push(`AGENT · ${item.text.trim()}`);
      } else if (item?.type === "command_execution") {
        const command = typeof item.command === "string" ? item.command : "command";
        if (event.type === "item.started") {
          commandsStarted += 1;
          activity.push(`COMMAND STARTED · ${command.slice(0, 700)}`);
        } else {
          commandsCompleted += 1;
          const exitCode = typeof item.exit_code === "number" ? item.exit_code : null;
          if (exitCode !== null && exitCode !== 0) commandsFailed += 1;
          const output = typeof item.aggregated_output === "string"
            ? item.aggregated_output.trim()
            : "";
          const outputTail = output.length > 4000 ? `…${output.slice(-4000)}` : output;
          activity.push(
            `COMMAND ${String(item.status ?? "completed").toUpperCase()}${
              exitCode === null ? "" : ` · exit ${exitCode}`
            } · ${command.slice(0, 700)}${
              outputTail ? `\nOUTPUT TAIL\n${outputTail}` : "\n(no output)"
            }`,
          );
        }
      } else if (item?.type === "reasoning" && typeof item.text === "string") {
        activity.push(`THINKING · ${item.text.trim().slice(0, 1400)}`);
      } else if (item?.type === "todo_list") {
        activity.push(`PLAN · ${JSON.stringify(item.items ?? []).slice(0, 1000)}`);
      }
    }
    const modified = stat.mtime?.getTime() ?? null;
    return {
      activity: activity.slice(-16),
      bytes: stat.size,
      modifiedAt: modified === null ? null : new Date(modified).toISOString(),
      ageSeconds: modified === null ? null : Math.max(0, (Date.now() - modified) / 1000),
      eventsInWindow,
      lastEventType,
      commandsStarted,
      commandsCompleted,
      commandsFailed,
    };
  } finally {
    file.close();
  }
}

async function serviceStates(
  environment: ResolvedAgentEnvironment,
): Promise<Record<string, string>> {
  const units = (environment.config.hostServices ?? []).map((service) =>
    service.source.split("/").at(-1)!
  );
  if (units.length === 0) return {};
  const output = await new Deno.Command("/usr/bin/systemctl", {
    args: ["--user", "is-active", ...units],
    stdin: "null",
    stdout: "piped",
    stderr: "null",
  }).output();
  const states = new TextDecoder().decode(output.stdout).trim().split("\n");
  return Object.fromEntries(
    units.map((unit, index) => [unit.replace(/\.service$/, ""), states[index] ?? "unknown"]),
  );
}

export async function serveWorkerDashboard(environment: ResolvedAgentEnvironment): Promise<never> {
  const worker = environment.config.worker;
  if (!worker || worker.kind !== "turn-loop") {
    throw new Error("The worker dashboard requires a turn-loop worker");
  }
  const handler = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const headers = {
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
    };
    if (url.pathname === "/api/status") {
      const campaign = await readJson(join(worker.metricsDirectory, "campaign.json"));
      const current = await readJson(join(worker.metricsDirectory, "current.json"));
      const eventLog = typeof current?.eventLog === "string" ? current.eventLog : undefined;
      const tail = await recentEvents(eventLog);
      let objective: string | null = null;
      try {
        objective = await Deno.readTextFile(
          worker.prompt,
        );
      } catch {
        // The activity and ledger remain useful if the source checkout moves.
      }
      return Response.json({
        environment: environment.config.name,
        campaign,
        current,
        serverTime: new Date().toISOString(),
        services: await serviceStates(environment),
        objective,
        eventLog: {
          bytes: tail.bytes,
          modifiedAt: tail.modifiedAt,
          ageSeconds: tail.ageSeconds,
          eventsInWindow: tail.eventsInWindow,
          lastEventType: tail.lastEventType,
          commandsStarted: tail.commandsStarted,
          commandsCompleted: tail.commandsCompleted,
          commandsFailed: tail.commandsFailed,
        },
        activity: tail.activity,
      }, { headers });
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return Response.json({ service: "lm-tools campaign observer", status: "/api/status" }, {
        headers,
      });
    }
    return new Response("Not found", { status: 404, headers });
  };
  console.log(`Agent observer API: http://127.0.0.1:${worker.dashboardPort}/api/status`);
  Deno.serve({ hostname: "127.0.0.1", port: worker.dashboardPort }, handler);
  return await new Promise<never>(() => {});
}
