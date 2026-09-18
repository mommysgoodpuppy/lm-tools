#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run=incus

import { dirname, resolve } from "jsr:@std/path@1";
import { AppendOnlyTextLog, MAXIMUM_TEXT_LOG_BYTES } from "../src/log.ts";

type Row = Record<string, unknown>;

interface Options {
  instance: string;
  database: string;
  journal: string;
  dryRun: boolean;
}

function usage(): string {
  return `Usage: deno run -A scripts/backfill_hermes_audit.ts --journal PATH [options]

Import Hermes' semantic SQLite conversation history into a free-router audit journal.
Imported records are explicitly marked reconstructed and use the same hashed
conversation identity as future live router requests.

Options:
  --instance NAME   Incus instance (default: lm-hermes)
  --database PATH   Hermes state database in the instance
  --journal PATH    Destination free-router append-only audit journal
  --dry-run         Inspect and report without writing
  --help            Show this help`;
}

function parseArgs(args: string[]): Options {
  let instance = "lm-hermes";
  let database = "/home/hermes/.hermes/state.db";
  let journal = "";
  let dryRun = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      Deno.exit(0);
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--instance" || arg === "--database" || arg === "--journal") {
      const value = args[++index];
      if (!value) throw new Error(`${arg} requires a value`);
      if (arg === "--instance") instance = value;
      if (arg === "--database") database = value;
      if (arg === "--journal") journal = resolve(value);
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  if (!journal) throw new Error(`--journal is required\n\n${usage()}`);
  return { instance, database, journal, dryRun };
}

async function sqliteRows(options: Options, sql: string): Promise<Row[]> {
  const command = new Deno.Command("incus", {
    args: ["exec", options.instance, "--", "sqlite3", "-json", options.database, sql],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  if (!output.success) throw new Error(new TextDecoder().decode(output.stderr).trim());
  const text = new TextDecoder().decode(output.stdout).trim();
  return text ? JSON.parse(text) : [];
}

async function opaqueId(value: string, prefix: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const hash = [...new Uint8Array(digest)].slice(0, 8).map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  return `${prefix}-${hash}`;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function modelMessage(row: Row): Row {
  const message: Row = { role: String(row.role ?? "unknown") };
  if (row.content !== null && row.content !== undefined) message.content = row.content;
  if (row.tool_call_id) message.tool_call_id = row.tool_call_id;
  if (row.tool_name) message.name = row.tool_name;
  const toolCalls = parseJson(row.tool_calls);
  if (toolCalls !== undefined) message.tool_calls = toolCalls;
  const reasoningDetails = parseJson(row.reasoning_details);
  if (reasoningDetails !== undefined) message.reasoning_details = reasoningDetails;
  return message;
}

function isoTimestamp(value: unknown): string {
  const seconds = typeof value === "number" ? value : Number(value);
  return new Date(seconds * 1_000).toISOString();
}

function sanitizedSource(value: unknown): string {
  return String(value ?? "hermes").toLowerCase().replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "hermes";
}

async function auditRecords(sessions: Row[], messages: Row[]): Promise<Row[]> {
  const bySession = new Map<string, Row[]>();
  for (const message of messages) {
    const sessionId = String(message.session_id);
    const values = bySession.get(sessionId) ?? [];
    values.push(message);
    bySession.set(sessionId, values);
  }
  const records: Row[] = [];
  for (const session of sessions) {
    const sessionId = String(session.id);
    const conversationId = await opaqueId(sessionId, "chat");
    const source = sanitizedSource(session.source);
    const label = String(session.label ?? "").trim();
    const model = String(session.model ?? "hermes-history");
    const systemPrompt = String(session.system_prompt ?? "").trim();
    let segment: Row[] = systemPrompt ? [{ role: "system", content: systemPrompt }] : [];
    let turnSeed = `session:${sessionId}:start`;
    for (const message of bySession.get(sessionId) ?? []) {
      const role = String(message.role);
      if (role === "user") turnSeed = `message:${String(message.id)}`;
      if (role !== "assistant") {
        segment.push(modelMessage(message));
        continue;
      }
      const assistant = modelMessage(message);
      const timestamp = isoTimestamp(message.timestamp);
      const user = [...segment].reverse().find((candidate) => candidate.role === "user");
      const content = typeof message.content === "string" ? message.content : "";
      const reasoning = typeof message.reasoning_content === "string" && message.reasoning_content
        ? message.reasoning_content
        : typeof message.reasoning === "string"
        ? message.reasoning
        : "";
      const response = {
        historical_import: true,
        choices: [{ message: assistant, finish_reason: message.finish_reason ?? null }],
      };
      const requestBody = { model, messages: segment };
      const serializedRequest = JSON.stringify(requestBody);
      const serializedResponse = JSON.stringify(response);
      records.push({
        id: await opaqueId(`${sessionId}:${String(message.id)}`, "hermes"),
        conversationId,
        conversationSource: source,
        ...(label ? { conversationLabel: label } : {}),
        turnId: await opaqueId(`${sessionId}:${turnSeed}`, "turn"),
        userMessage: typeof user?.content === "string" ? user.content : "",
        requestBody,
        responseChunks: [response],
        capture: {
          origin: "hermes-backfill",
          requestBody: "reconstructed",
          requestBodyCharacters: serializedRequest.length,
          latestUserMessage: "reconstructed",
          responseChunks: "reconstructed",
          responseChunkCharacters: serializedResponse.length,
          reasoning: "reconstructed",
          content: "reconstructed",
          omitted: [
            "exact historical wire request",
            "concrete provider route and failover events",
            "raw upstream streaming chunks",
            "historical tool definitions when absent from Hermes message storage",
          ],
        },
        publicModel: model,
        startedAt: timestamp,
        updatedAt: timestamp,
        completedAt: timestamp,
        status: "completed",
        reasoning,
        content,
        routes: [{ type: "imported", at: timestamp, provider: "hermes-history", model }],
        ...(typeof message.token_count === "number"
          ? { usage: { completion_tokens: message.token_count } }
          : {}),
      });
      segment = [assistant];
    }
  }
  return records.sort((left, right) =>
    Date.parse(String(left.startedAt)) - Date.parse(String(right.startedAt))
  );
}

async function main(): Promise<void> {
  const options = parseArgs(Deno.args);
  const sessions = await sqliteRows(
    options,
    `select id, source, coalesce(display_name, title, '') as label, model, system_prompt
       from sessions order by started_at, id`,
  );
  const messages = await sqliteRows(
    options,
    `select id, session_id, role, content, tool_call_id, tool_calls, tool_name,
            timestamp, token_count, finish_reason, reasoning, reasoning_content,
            reasoning_details, compacted, active
       from messages order by timestamp, id`,
  );
  const records = await auditRecords(sessions, messages);
  const statePath = `${options.journal}.hermes-backfill.json`;
  try {
    const state = JSON.parse(await Deno.readTextFile(statePath));
    if (state?.completed === true) {
      console.log(`Hermes backfill already completed: ${statePath}`);
      return;
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  const encodedBytes = records.reduce(
    (total, record) =>
      total +
      new TextEncoder().encode(JSON.stringify({ version: 1, request: record }) + "\n").byteLength,
    0,
  );
  console.log(
    `${
      options.dryRun ? "Would import" : "Importing"
    } ${records.length} reconstructed inference records from ${sessions.length} Hermes sessions (${encodedBytes} bytes)`,
  );
  if (options.dryRun) return;
  const journal = new AppendOnlyTextLog(options.journal, { maximumBytes: MAXIMUM_TEXT_LOG_BYTES });
  if (journal.bytes + encodedBytes > journal.maximumBytes) {
    throw new Error("Hermes backfill would cross the 2 GiB audit journal capacity");
  }
  for (const record of records) {
    await journal.append(JSON.stringify({ version: 1, request: record }) + "\n");
  }
  await Deno.mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
  await Deno.writeTextFile(
    statePath,
    JSON.stringify({
      version: 1,
      completed: true,
      importedAt: new Date().toISOString(),
      records: records.length,
    }) + "\n",
    { mode: 0o600 },
  );
  console.log(`Backfill complete: ${options.journal}`);
}

if (import.meta.main) await main();
