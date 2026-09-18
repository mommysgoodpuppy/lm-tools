import { dirname, join } from "jsr:@std/path@1";
import type { AttemptHarness, ResolvedAgentEnvironment } from "./agent_environment.ts";

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

interface RepositorySnapshot {
  head: string;
  status: string;
}

interface AttemptRun {
  id: string;
  startedAt: string;
  finishedAt: string;
  durationSeconds: number;
  exitCode: number;
  timedOut: boolean;
  usage: TokenUsage;
  compactions: number;
  semanticCompactions: number;
  compactionReminders: number;
  eventLog: string;
  stateBefore: string | null;
  stateAfter: string | null;
  repositoriesBefore: Record<string, RepositorySnapshot>;
  repositoriesAfter: Record<string, RepositorySnapshot>;
  finalMessage: string | null;
  summary?: TurnResearchSummary;
  phases?: AttemptPhaseRun[];
}

export interface TurnResearchSummary {
  runId: string;
  generatedAt: string;
  source: "model-generated" | "qwen-generated" | "manual-backfill" | "fallback";
  title: string;
  status: "progress" | "blocked" | "falsified" | "measurement-requested" | "candidate-ready";
  summary: string;
  outcome: string;
  evidence: string[];
  changes: string[];
  nextStep: string;
  error?: string;
}

interface TurnSummaryLedger {
  version: 1;
  environment: string;
  updatedAt: string;
  entries: TurnResearchSummary[];
}

interface AttemptPhaseRun {
  name: string;
  startedAt: string;
  finishedAt: string;
  durationSeconds: number;
  exitCode: number;
  timedOut: boolean;
  workTimedOut?: boolean;
  finalizationAttempted?: boolean;
  requiredChangedFiles: string[];
}

interface CampaignLedger {
  version: 1;
  environment: string;
  startedAt: string;
  updatedAt: string;
  runs: number;
  successfulRuns: number;
  failedRuns: number;
  wallSeconds: number;
  usage: TokenUsage;
  compactions: number;
  semanticCompactions: number;
  compactionReminders: number;
  history: AttemptRun[];
}

const ZERO_USAGE: TokenUsage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
};

const SUMMARY_STATUSES = new Set<TurnResearchSummary["status"]>([
  "progress",
  "blocked",
  "falsified",
  "measurement-requested",
  "candidate-ready",
]);

function textField(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Turn summary ${name} must be a non-empty string`);
  }
  return value.trim();
}

function textList(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`Turn summary ${name} must be an array of strings`);
  }
  return value.map((item) => item.trim()).filter(Boolean).slice(0, 12);
}

export function parseTurnResearchSummary(text: string, runId: string): TurnResearchSummary {
  const fenced = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Turn summary did not contain a JSON object");
  const value = JSON.parse(fenced.slice(start, end + 1)) as Record<string, unknown>;
  const status = textField(value.status, "status") as TurnResearchSummary["status"];
  if (!SUMMARY_STATUSES.has(status)) throw new Error(`Invalid turn summary status: ${status}`);
  return {
    runId,
    generatedAt: new Date().toISOString(),
    source: "model-generated",
    title: textField(value.title, "title"),
    status,
    summary: textField(value.summary, "summary"),
    outcome: textField(value.outcome, "outcome"),
    evidence: textList(value.evidence, "evidence"),
    changes: textList(value.changes, "changes"),
    nextStep: textField(value.nextStep, "nextStep"),
  };
}

function numberField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function parseCodexEventUsage(lines: string[]): {
  usage: TokenUsage;
  finalMessage: string | null;
  compactions: number;
  semanticCompactions: number;
  compactionReminders: number;
} {
  const usage = { ...ZERO_USAGE };
  let finalMessage: string | null = null;
  const appServerUsage = new Map<string, TokenUsage>();
  let compactions = 0;
  let semanticCompactions = 0;
  let compactionReminders = 0;
  for (const line of lines) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.type === "turn.completed") {
      const raw = (event.usage ?? {}) as Record<string, unknown>;
      usage.inputTokens += numberField(raw.input_tokens);
      usage.cachedInputTokens += numberField(raw.cached_input_tokens);
      usage.outputTokens += numberField(raw.output_tokens);
    }
    if (event.type === "lm_tools.context_reminder") compactionReminders += 1;
    if (event.type === "item.completed") {
      const item = event.item as Record<string, unknown> | undefined;
      if (item?.type === "agent_message" && typeof item.text === "string") {
        finalMessage = item.text;
      }
    }
    if (event.method === "thread/tokenUsage/updated") {
      const params = (event.params ?? {}) as Record<string, unknown>;
      const threadId = typeof params.threadId === "string" ? params.threadId : "legacy";
      const tokenUsage = (params.tokenUsage ?? {}) as Record<string, unknown>;
      const total = (tokenUsage.total ?? {}) as Record<string, unknown>;
      appServerUsage.set(threadId, {
        inputTokens: numberField(total.inputTokens),
        cachedInputTokens: numberField(total.cachedInputTokens),
        outputTokens: numberField(total.outputTokens),
        totalTokens: numberField(total.totalTokens),
      });
    }
    if (event.method === "item/completed") {
      const params = (event.params ?? {}) as Record<string, unknown>;
      const item = params.item as Record<string, unknown> | undefined;
      if (item?.type === "agentMessage" && typeof item.text === "string") {
        finalMessage = item.text;
      }
      if (item?.type === "contextCompaction") compactions += 1;
      if (item?.type === "dynamicToolCall" && item.tool === SEMANTIC_COMPACT_TOOL.name) {
        semanticCompactions += 1;
      }
    }
  }
  if (appServerUsage.size > 0) {
    const sessionUsage = [...appServerUsage.values()].reduce(addUsage, { ...ZERO_USAGE });
    return {
      usage: sessionUsage,
      finalMessage,
      compactions,
      semanticCompactions,
      compactionReminders,
    };
  }
  usage.totalTokens = usage.inputTokens + usage.outputTokens;
  return { usage, finalMessage, compactions, semanticCompactions, compactionReminders };
}

export function parsePiRpcEvents(lines: string[]): {
  usage: TokenUsage;
  finalMessage: string | null;
  compactions: number;
  semanticCompactions: number;
  compactionReminders: number;
} {
  let usage = { ...ZERO_USAGE };
  const fallbackUsage = { ...ZERO_USAGE };
  let finalMessage: string | null = null;
  let compactions = 0;
  let hasSessionStats = false;
  for (const line of lines) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.type === "compaction_end" && event.aborted !== true && event.result) {
      compactions += 1;
    }
    if (event.type === "message_end") {
      const message = (event.message ?? {}) as Record<string, unknown>;
      if (message.role === "assistant") {
        const raw = (message.usage ?? {}) as Record<string, unknown>;
        fallbackUsage.inputTokens += numberField(raw.input);
        fallbackUsage.cachedInputTokens += numberField(raw.cacheRead);
        fallbackUsage.outputTokens += numberField(raw.output);
        fallbackUsage.totalTokens += numberField(raw.totalTokens);
        const content = Array.isArray(message.content) ? message.content : [];
        const text = content
          .filter((item): item is Record<string, unknown> =>
            item !== null && typeof item === "object" && !Array.isArray(item)
          )
          .filter((item) => item.type === "text" && typeof item.text === "string")
          .map((item) => item.text as string)
          .join("");
        if (text) finalMessage = text;
      }
    }
    if (event.type === "response" && event.success === true) {
      const data = (event.data ?? {}) as Record<string, unknown>;
      if (event.command === "get_session_stats") {
        const tokens = (data.tokens ?? {}) as Record<string, unknown>;
        usage = {
          inputTokens: numberField(tokens.input),
          cachedInputTokens: numberField(tokens.cacheRead),
          outputTokens: numberField(tokens.output),
          totalTokens: numberField(tokens.total),
        };
        hasSessionStats = true;
      }
      if (event.command === "get_last_assistant_text" && typeof data.text === "string") {
        finalMessage = data.text;
      }
    }
  }
  return {
    usage: hasSessionStats ? usage : fallbackUsage,
    finalMessage,
    compactions,
    semanticCompactions: 0,
    compactionReminders: 0,
  };
}

type JsonObject = Record<string, unknown>;

export const SEMANTIC_COMPACT_TOOL = {
  type: "function",
  name: "compact_context",
  description:
    "Compact the conversation and continue the same work session. Call only at a clean task-phase " +
    "boundary, after useful conclusions and workspace state are established and earlier exploration " +
    "has become noise. Do not call merely because the context is large, during an unfinished edit or " +
    "test, or to end the work session. After calling, stop the current turn; lm-tools will compact and " +
    "resume with the requested next action.",
  inputSchema: {
    type: "object",
    properties: {
      reason: {
        type: "string",
        description: "Why the completed phase can now be replaced by a checkpoint.",
      },
      next_action: {
        type: "string",
        description: "The exact first action to take after compaction.",
      },
    },
    required: ["reason", "next_action"],
    additionalProperties: false,
  },
} as const;

function jsonObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

async function writeRpc(writer: WritableStreamDefaultWriter<Uint8Array>, message: unknown) {
  await writer.write(new TextEncoder().encode(`${JSON.stringify(message)}\n`));
}

async function handleServerRequest(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  message: JsonObject,
): Promise<void> {
  if (!("id" in message) || typeof message.method !== "string") return;
  if (
    message.method === "item/commandExecution/requestApproval" ||
    message.method === "item/fileChange/requestApproval"
  ) {
    await writeRpc(writer, { id: message.id, result: { decision: "acceptForSession" } });
    return;
  }
  if (message.method === "item/tool/requestUserInput") {
    await writeRpc(writer, { id: message.id, result: { answers: {} } });
    return;
  }
  await writeRpc(writer, {
    id: message.id,
    error: { code: -32601, message: `Unsupported autonomous harness request: ${message.method}` },
  });
}

export async function runAppServerTurn(
  environment: ResolvedAgentEnvironment,
  prompt: string,
  eventLog: string,
  timing?: { timeoutSeconds: number; wrapUpSeconds: number; appendEventLog?: boolean },
): Promise<{ exitCode: number; timedOut: boolean; lines: string[] }> {
  const harness = harnessConfig(environment);
  const { backend, guest } = environment.config;
  const semanticCompaction = harness.compaction?.mode === "model-directed";
  const maxSemanticCompactions = harness.compaction?.maxPerSession ?? 0;
  const semanticReminderTokens = harness.compaction?.reminderTokens ?? 0;
  const command = new Deno.Command("/usr/bin/timeout", {
    args: [
      "--signal=TERM",
      "--kill-after=30s",
      String(timing?.timeoutSeconds ?? harness.timeoutSeconds),
      backend.executable,
      "exec",
      "-T",
      "--user",
      String(guest.uid),
      "--group",
      String(guest.gid),
      "--cwd",
      guest.workspace,
      "--env",
      `HOME=${guest.home}`,
      backend.instance,
      "--",
      "codex",
      "app-server",
      "--listen",
      "stdio://",
    ],
    stdin: "piped",
    stdout: "piped",
    stderr: "inherit",
  }).spawn();
  const writer = command.stdin.getWriter();
  const raw = await Deno.open(
    eventLog,
    timing?.appendEventLog
      ? { create: true, append: true, write: true }
      : { createNew: true, write: true },
  );
  const lines: string[] = [];
  const decoder = new TextDecoder();
  let pending = "";
  let turnStatus: string | null = null;
  let threadId: string | null = null;
  let activeTurnId: string | null = null;
  let phase: "working" | "compacting" = "working";
  let semanticCompactRequested = false;
  let semanticCompactions = 0;
  let semanticReminderSent = false;
  let semanticNextAction = "Continue the bounded optimization from the compacted checkpoint.";
  let requestId = 10;
  let writerClosed = false;
  const timeoutSeconds = timing?.timeoutSeconds ?? harness.timeoutSeconds;
  const wrapUpSeconds = timing?.wrapUpSeconds ?? harness.wrapUpSeconds ??
    Math.floor(timeoutSeconds * 0.8);
  if (wrapUpSeconds >= timeoutSeconds) {
    throw new Error("Harness wrapUpSeconds must be less than timeoutSeconds");
  }
  const wrapUpTimer = setTimeout(async () => {
    if (writerClosed || !threadId || !activeTurnId) return;
    const remaining = Math.max(1, timeoutSeconds - wrapUpSeconds);
    await writeRpc(writer, {
      method: "turn/steer",
      id: 4,
      params: {
        threadId,
        expectedTurnId: activeTurnId,
        input: [{
          type: "text",
          text:
            `You have about ${Math.ceil(remaining / 60)} minutes before this phase is forcibly ` +
            "ended. Do not reopen the phase's decision. Produce its required durable artifact, " +
            "leave the workspace consistent, and end this turn cleanly now.",
        }],
      },
    }).catch(() => undefined);
  }, wrapUpSeconds * 1000);
  let noticeBusy = false;
  const noticeTimer = setInterval(async () => {
    if (noticeBusy || writerClosed || phase !== "working" || !threadId || !activeTurnId) return;
    noticeBusy = true;
    try {
      const notice = JSON.parse(await Deno.readTextFile(harness.liveNoticePath)) as {
        id?: string;
        message?: string;
      };
      if (typeof notice.message !== "string" || notice.message.trim().length === 0) return;
      await writeRpc(writer, {
        method: "turn/steer",
        id: requestId++,
        params: {
          threadId,
          expectedTurnId: activeTurnId,
          input: [{
            type: "text",
            text: `[lm-tools live campaign update]\n${notice.message}`,
          }],
        },
      });
      await appendSyntheticEvent(eventLog, {
        type: "lm_tools.live_notice",
        noticeId: notice.id ?? null,
        message: notice.message,
      });
      await Deno.remove(harness.liveNoticePath);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        console.error(`Could not deliver live harness notice: ${error}`);
      }
    } finally {
      noticeBusy = false;
    }
  }, 1000);

  await writeRpc(writer, {
    method: "initialize",
    id: 1,
    params: {
      clientInfo: {
        name: "lm_tools_worker",
        title: "lm-tools autonomous harness",
        version: "0.1.0",
      },
      capabilities: semanticCompaction ? { experimentalApi: true } : undefined,
    },
  });

  const processLine = async (line: string) => {
    if (!line) return;
    lines.push(line);
    await raw.write(new TextEncoder().encode(`${line}\n`));
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    const message = jsonObject(parsed);
    if (!message) return;
    if (message.error && (message.id === 1 || message.id === 2 || message.id === 3)) {
      throw new Error(
        `Codex app-server request ${message.id} failed: ${JSON.stringify(message.error)}`,
      );
    }
    if (message.id === 1) {
      await writeRpc(writer, { method: "initialized", params: {} });
      await writeRpc(writer, {
        method: "thread/start",
        id: 2,
        params: {
          cwd: guest.workspace,
          approvalPolicy: "never",
          sandbox: "danger-full-access",
          ephemeral: true,
          serviceName: "lm_tools_worker",
          dynamicTools: semanticCompaction ? [SEMANTIC_COMPACT_TOOL] : undefined,
        },
      });
      return;
    }
    if (message.id === 2) {
      const result = jsonObject(message.result);
      const thread = jsonObject(result?.thread);
      if (typeof thread?.id !== "string") throw new Error("thread/start returned no thread id");
      threadId = thread.id;
      await writeRpc(writer, {
        method: "turn/start",
        id: 3,
        params: {
          threadId: thread.id,
          input: [{ type: "text", text: prompt }],
          cwd: guest.workspace,
          approvalPolicy: "never",
          sandboxPolicy: { type: "dangerFullAccess" },
        },
      });
      return;
    }
    if (message.id === 3) {
      const result = jsonObject(message.result);
      const turn = jsonObject(result?.turn);
      if (typeof turn?.id === "string") activeTurnId = turn.id;
      return;
    }
    if (message.method === "turn/started") {
      const params = jsonObject(message.params);
      const turn = jsonObject(params?.turn);
      if (typeof turn?.id === "string") activeTurnId = turn.id;
    }
    if (
      semanticCompaction && !semanticReminderSent && phase === "working" && threadId &&
      activeTurnId &&
      message.method === "thread/tokenUsage/updated"
    ) {
      const params = jsonObject(message.params);
      const tokenUsage = jsonObject(params?.tokenUsage);
      const last = jsonObject(tokenUsage?.last);
      const activeTokens = numberField(last?.totalTokens);
      if (activeTokens >= semanticReminderTokens) {
        semanticReminderSent = true;
        const reminderEvent = JSON.stringify({
          type: "lm_tools.context_reminder",
          activeTokens,
          thresholdTokens: semanticReminderTokens,
        });
        lines.push(reminderEvent);
        await raw.write(new TextEncoder().encode(`${reminderEvent}\n`));
        await writeRpc(writer, {
          method: "turn/steer",
          id: requestId++,
          params: {
            threadId,
            expectedTurnId: activeTurnId,
            input: [{
              type: "text",
              text: `[lm-tools context reminder] Active context is about ${activeTokens} tokens. ` +
                "At the next coherent task-phase boundary, consider calling compact_context. " +
                "Do not interrupt an unfinished edit, command, or test merely to compact.",
            }],
          },
        });
      }
    }
    if (message.method === "item/tool/call" && "id" in message) {
      const params = jsonObject(message.params);
      if (!semanticCompaction || params?.tool !== SEMANTIC_COMPACT_TOOL.name) {
        await handleServerRequest(writer, message);
        return;
      }
      if (semanticCompactions >= maxSemanticCompactions) {
        await writeRpc(writer, {
          id: message.id,
          result: {
            contentItems: [{
              type: "inputText",
              text: "Semantic compaction limit reached. Finish the current bounded candidate.",
            }],
            success: false,
          },
        });
        return;
      }
      const arguments_ = jsonObject(params.arguments);
      semanticNextAction = typeof arguments_?.next_action === "string"
        ? arguments_.next_action
        : semanticNextAction;
      semanticCompactRequested = true;
      await writeRpc(writer, {
        id: message.id,
        result: {
          contentItems: [{
            type: "inputText",
            text: "Compaction is scheduled. Stop this turn now without doing more work; the same " +
              "session will resume from a structured checkpoint.",
          }],
          success: true,
        },
      });
      if (threadId && activeTurnId) {
        await writeRpc(writer, {
          method: "turn/steer",
          id: requestId++,
          params: {
            threadId,
            expectedTurnId: activeTurnId,
            input: [{
              type: "text",
              text:
                "Honor the compact_context request: stop this turn now. Do not perform another " +
                "tool call or start the next phase before compaction.",
            }],
          },
        });
      }
      return;
    }
    if (message.method === "turn/completed") {
      const params = jsonObject(message.params);
      const turn = jsonObject(params?.turn);
      turnStatus = typeof turn?.status === "string" ? turn.status : "failed";
      activeTurnId = null;
      if (turnStatus === "completed" && phase === "working" && semanticCompactRequested) {
        if (!threadId) throw new Error("Semantic compaction completed without a thread id");
        semanticCompactRequested = false;
        semanticCompactions += 1;
        phase = "compacting";
        await writeRpc(writer, {
          method: "thread/compact/start",
          id: requestId++,
          params: { threadId },
        });
        return;
      }
      if (turnStatus === "completed" && phase === "compacting") {
        if (!threadId) throw new Error("Compaction turn completed without a thread id");
        phase = "working";
        semanticReminderSent = false;
        await writeRpc(writer, {
          method: "turn/start",
          id: requestId++,
          params: {
            threadId,
            input: [{
              type: "text",
              text:
                "Context compaction completed at your request. Continue the same work session. " +
                `Your declared next action was: ${semanticNextAction}`,
            }],
            cwd: guest.workspace,
            approvalPolicy: "never",
            sandboxPolicy: { type: "dangerFullAccess" },
          },
        });
        return;
      }
      if (!writerClosed) {
        writerClosed = true;
        await writer.close();
      }
      return;
    }
    await handleServerRequest(writer, message);
  };

  try {
    for await (const chunk of command.stdout) {
      pending += decoder.decode(chunk, { stream: true });
      const split = pending.split("\n");
      pending = split.pop() ?? "";
      for (const line of split) await processLine(line);
    }
    pending += decoder.decode();
    if (pending) await processLine(pending);
  } finally {
    clearTimeout(wrapUpTimer);
    clearInterval(noticeTimer);
    raw.close();
    if (!writerClosed) {
      writerClosed = true;
      await writer.close().catch(() => undefined);
    }
  }
  const status = await command.status;
  const timedOut = status.code === 124;
  return {
    exitCode: !timedOut && turnStatus === "completed" ? 0 : status.code || 1,
    timedOut,
    lines,
  };
}

async function runPiRpcTurn(
  environment: ResolvedAgentEnvironment,
  prompt: string,
  eventLog: string,
): Promise<{ exitCode: number; timedOut: boolean; lines: string[] }> {
  const harness = harnessConfig(environment);
  const { backend, guest } = environment.config;
  const piCommand = harness.command;
  if (!piCommand?.length) {
    throw new Error("A pi-rpc harness requires an explicit harness.command");
  }
  const command = new Deno.Command("/usr/bin/timeout", {
    args: [
      "--signal=TERM",
      "--kill-after=30s",
      String(harness.timeoutSeconds),
      backend.executable,
      "exec",
      "-T",
      "--user",
      String(guest.uid),
      "--group",
      String(guest.gid),
      "--cwd",
      guest.workspace,
      "--env",
      `HOME=${guest.home}`,
      "--env",
      "PI_OFFLINE=1",
      backend.instance,
      "--",
      ...piCommand,
    ],
    stdin: "piped",
    stdout: "piped",
    stderr: "inherit",
  }).spawn();
  const writer = command.stdin.getWriter();
  const raw = await Deno.open(eventLog, { createNew: true, write: true });
  const lines: string[] = [];
  const decoder = new TextDecoder();
  let pending = "";
  let settled = false;
  let statsReceived = false;
  let finalMessageReceived = false;
  let writerClosed = false;
  const wrapUpSeconds = harness.wrapUpSeconds ?? Math.floor(harness.timeoutSeconds * 0.8);
  if (wrapUpSeconds >= harness.timeoutSeconds) {
    throw new Error("Harness wrapUpSeconds must be less than timeoutSeconds");
  }
  const closeWhenComplete = async () => {
    if (!settled || !statsReceived || !finalMessageReceived || writerClosed) return;
    writerClosed = true;
    await writer.close();
  };
  const wrapUpTimer = setTimeout(async () => {
    if (writerClosed || settled) return;
    const remaining = Math.max(1, harness.timeoutSeconds - wrapUpSeconds);
    await writeRpc(writer, {
      type: "steer",
      message:
        `You have about ${Math.ceil(remaining / 60)} minutes before the hard session limit. ` +
        "Stop broad exploration, finish the current bounded change, run the cheapest relevant " +
        "checks, update the durable state and handoff files, write any evaluation request, " +
        "and then end cleanly.",
    }).catch(() => undefined);
  }, wrapUpSeconds * 1000);

  await writeRpc(writer, { id: "lm-tools-prompt", type: "prompt", message: prompt });

  const processLine = async (line: string) => {
    if (!line) return;
    lines.push(line);
    await raw.write(new TextEncoder().encode(`${line}\n`));
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    const message = jsonObject(parsed);
    if (!message) return;
    if (message.type === "agent_settled" && !settled) {
      settled = true;
      await writeRpc(writer, { id: "lm-tools-stats", type: "get_session_stats" });
      await writeRpc(writer, { id: "lm-tools-final", type: "get_last_assistant_text" });
      return;
    }
    if (message.type === "response") {
      if (message.id === "lm-tools-prompt" && message.success === false) {
        throw new Error(`Pi rejected the harness prompt: ${String(message.error)}`);
      }
      if (message.id === "lm-tools-stats") statsReceived = true;
      if (message.id === "lm-tools-final") finalMessageReceived = true;
      await closeWhenComplete();
      return;
    }
    if (message.type === "extension_ui_request" && typeof message.id === "string") {
      if (message.method === "confirm") {
        await writeRpc(writer, {
          type: "extension_ui_response",
          id: message.id,
          confirmed: false,
        });
      } else if (["select", "input", "editor"].includes(String(message.method))) {
        await writeRpc(writer, {
          type: "extension_ui_response",
          id: message.id,
          cancelled: true,
        });
      }
    }
  };

  try {
    for await (const chunk of command.stdout) {
      pending += decoder.decode(chunk, { stream: true });
      const split = pending.split("\n");
      pending = split.pop() ?? "";
      for (const line of split) await processLine(line.endsWith("\r") ? line.slice(0, -1) : line);
    }
    pending += decoder.decode();
    if (pending) await processLine(pending.endsWith("\r") ? pending.slice(0, -1) : pending);
  } finally {
    clearTimeout(wrapUpTimer);
    raw.close();
    if (!writerClosed) {
      writerClosed = true;
      await writer.close().catch(() => undefined);
    }
  }
  const status = await command.status;
  const timedOut = status.code === 124;
  return {
    exitCode: !timedOut && settled ? 0 : status.code || 1,
    timedOut,
    lines,
  };
}

/**
 * Reassembly of OMP protocol v2 `rpc_chunk` sequences into logical frames.
 *
 * Ported from vendor/omp `packages/coding-agent/src/modes/rpc/rpc-frame.ts`
 * at the pinned revision; that module is the canonical wire contract. OMP caps
 * one stdout frame at 1 MiB; larger logical frames arrive losslessly as base64
 * chunks only after the host negotiates protocol v2.
 */
const OMP_MAX_REASSEMBLED_BYTES = 64 * 1024 * 1024;

interface OmpChunkFrame {
  type: "rpc_chunk";
  chunkId: string;
  index: number;
  count: number;
  byteLength: number;
  data: string;
}

export class OmpRpcFrameDecoder {
  #chunks = new Map<string, {
    count: number;
    byteLength: number;
    nextIndex: number;
    bytes: Uint8Array[];
    receivedBytes: number;
  }>();

  decode(chunk: unknown): string | null {
    const frame = chunk as OmpChunkFrame;
    if (
      frame.type !== "rpc_chunk" || typeof frame.chunkId !== "string" ||
      typeof frame.index !== "number" || typeof frame.count !== "number" ||
      typeof frame.byteLength !== "number" || typeof frame.data !== "string"
    ) {
      throw new Error("Malformed OMP rpc_chunk frame");
    }
    if (frame.count < 1 || frame.byteLength < 1 || frame.byteLength > OMP_MAX_REASSEMBLED_BYTES) {
      throw new Error(`OMP rpc_chunk ${frame.chunkId} has invalid envelope`);
    }
    let pending = this.#chunks.get(frame.chunkId);
    if (!pending) {
      pending = {
        count: frame.count,
        byteLength: frame.byteLength,
        nextIndex: 0,
        bytes: [],
        receivedBytes: 0,
      };
      this.#chunks.set(frame.chunkId, pending);
    } else if (pending.count !== frame.count || pending.byteLength !== frame.byteLength) {
      throw new Error(`OMP rpc_chunk ${frame.chunkId} envelope changed mid-sequence`);
    }
    if (frame.index !== pending.nextIndex) {
      throw new Error(
        `OMP rpc_chunk ${frame.chunkId} arrived out of order: expected ${pending.nextIndex}, got ${frame.index}`,
      );
    }
    const bytes = Uint8Array.from(atob(frame.data), (character) => character.charCodeAt(0));
    pending.bytes.push(bytes);
    pending.receivedBytes += bytes.length;
    pending.nextIndex = frame.index + 1;
    if (pending.receivedBytes > pending.byteLength) {
      throw new Error(`OMP rpc_chunk ${frame.chunkId} exceeded declared byteLength`);
    }
    if (pending.nextIndex < pending.count) return null;
    this.#chunks.delete(frame.chunkId);
    if (pending.receivedBytes !== pending.byteLength) {
      throw new Error(`OMP rpc_chunk ${frame.chunkId} byte length mismatch`);
    }
    const total = pending.bytes.reduce((sum, part) => sum + part.length, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const part of pending.bytes) {
      merged.set(part, offset);
      offset += part.length;
    }
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(merged);
    if (decoded.length > OMP_MAX_REASSEMBLED_BYTES) {
      throw new Error(`OMP reassembled frame exceeds ${OMP_MAX_REASSEMBLED_BYTES} bytes`);
    }
    return decoded;
  }
}

async function runOmpRpcTurn(
  environment: ResolvedAgentEnvironment,
  prompt: string,
  eventLog: string,
  options: { attemptId: string },
): Promise<{ exitCode: number; timedOut: boolean; lines: string[] }> {
  const harness = harnessConfig(environment);
  const { backend, guest } = environment.config;
  const commandArgv = harness.command?.length ? harness.command : [
    "omp",
    "--mode",
    "rpc",
    "--no-lsp",
    ...(harness.model ? ["--model", harness.model] : []),
    "--session-dir",
    join(guest.workspace, ".lm-tools", "omp-sessions", options.attemptId),
  ];
  const command = new Deno.Command("/usr/bin/timeout", {
    args: [
      "--signal=TERM",
      "--kill-after=30s",
      String(harness.timeoutSeconds),
      backend.executable,
      "exec",
      "-T",
      "--user",
      String(guest.uid),
      "--group",
      String(guest.gid),
      "--cwd",
      guest.workspace,
      "--env",
      `HOME=${guest.home}`,
      backend.instance,
      "--",
      ...commandArgv,
    ],
    stdin: "piped",
    stdout: "piped",
    stderr: "inherit",
  }).spawn();
  const writer = command.stdin.getWriter();
  const raw = await Deno.open(eventLog, { createNew: true, write: true });
  const lines: string[] = [];
  const decoder = new TextDecoder();
  const chunkDecoder = new OmpRpcFrameDecoder();
  let pending = "";
  let settled = false;
  let statsReceived = false;
  let finalMessageReceived = false;
  let writerClosed = false;
  const wrapUpSeconds = harness.wrapUpSeconds ?? Math.floor(harness.timeoutSeconds * 0.8);
  if (wrapUpSeconds >= harness.timeoutSeconds) {
    throw new Error("Harness wrapUpSeconds must be less than timeoutSeconds");
  }
  const closeWhenComplete = async () => {
    if (!settled || !statsReceived || !finalMessageReceived || writerClosed) return;
    writerClosed = true;
    await writer.close();
  };
  const wrapUpTimer = setTimeout(async () => {
    if (writerClosed || settled) return;
    const remaining = Math.max(1, harness.timeoutSeconds - wrapUpSeconds);
    await writeRpc(writer, {
      type: "steer",
      message:
        `You have about ${Math.ceil(remaining / 60)} minutes before the hard session limit. ` +
        "Stop broad exploration, finish the current bounded change, run the cheapest relevant " +
        "checks, update the durable state and handoff files, write any evaluation request, " +
        "and then end cleanly.",
    }).catch(() => undefined);
  }, wrapUpSeconds * 1000);

  await writeRpc(writer, { id: "lm-tools-prompt", type: "prompt", message: prompt });

  const processLogicalLine = async (line: string): Promise<void> => {
    if (!line) return;
    lines.push(line);
    await raw.write(new TextEncoder().encode(`${line}\n`));
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    const message = jsonObject(parsed);
    if (!message) return;
    if (message.type === "ready") {
      const supported = Array.isArray(message.supportedProtocolVersions)
        ? message.supportedProtocolVersions as unknown[]
        : [];
      if (supported.includes(2)) {
        await writeRpc(writer, {
          id: "lm-tools-protocol",
          type: "negotiate_protocol",
          protocolVersion: 2,
        });
      }
      return;
    }
    if (message.type === "agent_end" && message.isTerminal !== false && !settled) {
      settled = true;
      await writeRpc(writer, { id: "lm-tools-stats", type: "get_session_stats" });
      await writeRpc(writer, { id: "lm-tools-final", type: "get_last_assistant_text" });
      return;
    }
    if (message.type === "response") {
      if (message.id === "lm-tools-prompt" && message.success === false) {
        throw new Error(`OMP rejected the harness prompt: ${String(message.error)}`);
      }
      if (message.id === "lm-tools-stats") statsReceived = true;
      if (message.id === "lm-tools-final") finalMessageReceived = true;
      await closeWhenComplete();
      return;
    }
    if (message.type === "extension_ui_request" && typeof message.id === "string") {
      if (message.method === "confirm") {
        await writeRpc(writer, {
          type: "extension_ui_response",
          id: message.id,
          confirmed: false,
        });
      } else if (["select", "input", "editor"].includes(String(message.method))) {
        await writeRpc(writer, {
          type: "extension_ui_response",
          id: message.id,
          cancelled: true,
        });
      }
    }
  };

  const processPhysicalLine = async (line: string): Promise<void> => {
    const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (jsonObject(parsed)?.type === "rpc_chunk") {
      const reassembled = chunkDecoder.decode(parsed);
      if (reassembled !== null) await processLogicalLine(reassembled);
      return;
    }
    await processLogicalLine(trimmed);
  };

  try {
    for await (const chunk of command.stdout) {
      pending += decoder.decode(chunk, { stream: true });
      const split = pending.split("\n");
      pending = split.pop() ?? "";
      for (const line of split) await processPhysicalLine(line);
    }
    pending += decoder.decode();
    if (pending) await processPhysicalLine(pending);
  } finally {
    clearTimeout(wrapUpTimer);
    raw.close();
    if (!writerClosed) {
      writerClosed = true;
      await writer.close().catch(() => undefined);
    }
  }
  const status = await command.status;
  const timedOut = status.code === 124;
  return {
    exitCode: !timedOut && settled ? 0 : status.code || 1,
    timedOut,
    lines,
  };
}

export function parseOmpRpcEvents(lines: string[]): {
  usage: TokenUsage;
  finalMessage: string | null;
  compactions: number;
  semanticCompactions: number;
  compactionReminders: number;
} {
  let usage = { ...ZERO_USAGE };
  const fallbackUsage = { ...ZERO_USAGE };
  let finalMessage: string | null = null;
  let compactions = 0;
  let hasSessionStats = false;
  for (const line of lines) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.type === "auto_compaction_end" && event.aborted !== true && event.result) {
      compactions += 1;
    }
    if (event.type === "message_end") {
      const message = (event.message ?? {}) as Record<string, unknown>;
      if (message.role === "assistant") {
        const raw = (message.usage ?? {}) as Record<string, unknown>;
        fallbackUsage.inputTokens += numberField(raw.input);
        fallbackUsage.cachedInputTokens += numberField(raw.cacheRead);
        fallbackUsage.outputTokens += numberField(raw.output);
        fallbackUsage.totalTokens += numberField(raw.totalTokens);
        const content = Array.isArray(message.content) ? message.content : [];
        const text = content
          .filter((item): item is Record<string, unknown> =>
            item !== null && typeof item === "object" && !Array.isArray(item)
          )
          .filter((item) => item.type === "text" && typeof item.text === "string")
          .map((item) => item.text as string)
          .join("");
        if (text) finalMessage = text;
      }
    }
    if (event.type === "response" && event.success === true) {
      const data = (event.data ?? {}) as Record<string, unknown>;
      if (event.command === "get_session_stats") {
        const tokens = (data.tokens ?? {}) as Record<string, unknown>;
        usage = {
          inputTokens: numberField(tokens.input),
          cachedInputTokens: numberField(tokens.cacheRead),
          outputTokens: numberField(tokens.output),
          totalTokens: numberField(tokens.total),
        };
        hasSessionStats = true;
      }
      if (event.command === "get_last_assistant_text" && typeof data.text === "string") {
        finalMessage = data.text;
      }
    }
  }
  return {
    usage: hasSessionStats ? usage : fallbackUsage,
    finalMessage,
    compactions,
    semanticCompactions: 0,
    compactionReminders: 0,
  };
}

async function runExecJsonTurn(
  environment: ResolvedAgentEnvironment,
  prompt: string,
  eventLog: string,
): Promise<{ exitCode: number; timedOut: boolean; lines: string[] }> {
  const harness = harnessConfig(environment);
  const { backend, guest } = environment.config;
  const command = new Deno.Command("/usr/bin/timeout", {
    args: [
      "--signal=TERM",
      "--kill-after=30s",
      String(harness.timeoutSeconds),
      backend.executable,
      "exec",
      "-T",
      "--user",
      String(guest.uid),
      "--group",
      String(guest.gid),
      "--cwd",
      guest.workspace,
      "--env",
      `HOME=${guest.home}`,
      backend.instance,
      "--",
      "codex",
      "exec",
      "--strict-config",
      "--json",
      "--ephemeral",
      "-C",
      guest.workspace,
      "-",
    ],
    stdin: "piped",
    stdout: "piped",
    stderr: "inherit",
  }).spawn();
  const writer = command.stdin.getWriter();
  await writer.write(new TextEncoder().encode(prompt));
  await writer.close();

  const raw = await Deno.open(eventLog, { createNew: true, write: true });
  const lines: string[] = [];
  const decoder = new TextDecoder();
  let pending = "";
  try {
    for await (const chunk of command.stdout) {
      await raw.write(chunk);
      pending += decoder.decode(chunk, { stream: true });
      const split = pending.split("\n");
      pending = split.pop() ?? "";
      lines.push(...split);
    }
    pending += decoder.decode();
    if (pending) lines.push(pending);
  } finally {
    raw.close();
  }
  const status = await command.status;
  return { exitCode: status.code, timedOut: status.code === 124, lines };
}

function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  };
}

async function guestOutput(
  environment: ResolvedAgentEnvironment,
  command: string[],
): Promise<string | null> {
  const { backend, guest } = environment.config;
  const output = await new Deno.Command(backend.executable, {
    args: [
      "exec",
      "-T",
      "--user",
      String(guest.uid),
      "--group",
      String(guest.gid),
      "--cwd",
      guest.workspace,
      "--env",
      `HOME=${guest.home}`,
      backend.instance,
      "--",
      ...command,
    ],
    stdin: "null",
    stdout: "piped",
    stderr: "null",
  }).output();
  return output.success ? new TextDecoder().decode(output.stdout).trim() : null;
}

async function stateHash(
  environment: ResolvedAgentEnvironment,
  statePath: string,
): Promise<string | null> {
  const output = await guestOutput(environment, ["sha256sum", statePath]);
  return output?.split(/\s+/, 1)[0] ?? null;
}

async function guestFileHash(
  environment: ResolvedAgentEnvironment,
  path: string,
): Promise<string | null> {
  return await stateHash(environment, path);
}

interface AttemptPhaseRequest {
  version: 1;
  next: string;
  reason?: string;
}

export function validateAttemptPhaseRequest(
  value: unknown,
  phaseNames: string[],
): AttemptPhaseRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("PHASE_REQUEST.json must be an object");
  }
  const request = value as Record<string, unknown>;
  for (const key of Object.keys(request)) {
    if (!new Set(["version", "next", "reason"]).has(key)) {
      throw new Error(`Unknown PHASE_REQUEST.json field: ${key}`);
    }
  }
  if (
    request.version !== 1 || typeof request.next !== "string" ||
    !phaseNames.includes(request.next)
  ) {
    throw new Error(`Invalid requested harness phase: ${String(request.next)}`);
  }
  if (request.reason !== undefined && typeof request.reason !== "string") {
    throw new Error("Attempt phase-request reason must be a string");
  }
  return request as unknown as AttemptPhaseRequest;
}

async function readAttemptPhaseRequest(
  environment: ResolvedAgentEnvironment,
  path: string,
  phaseNames: string[],
): Promise<AttemptPhaseRequest | undefined> {
  const text = await guestOutput(environment, ["cat", path]);
  if (text === null) return undefined;
  const request = validateAttemptPhaseRequest(JSON.parse(text), phaseNames);
  await guestOutput(environment, ["rm", "-f", path]);
  return request;
}

async function appendSyntheticEvent(path: string, event: Record<string, unknown>): Promise<void> {
  await Deno.writeTextFile(path, `${JSON.stringify(event)}\n`, { append: true, create: true });
}

async function repositorySnapshots(
  environment: ResolvedAgentEnvironment,
  repositories: string[],
): Promise<Record<string, RepositorySnapshot>> {
  const snapshots: Record<string, RepositorySnapshot> = {};
  for (const repository of repositories) {
    snapshots[repository] = {
      head: (await guestOutput(environment, ["git", "-C", repository, "rev-parse", "HEAD"])) ??
        "unavailable",
      status:
        (await guestOutput(environment, ["git", "-C", repository, "status", "--porcelain=v1"])) ??
          "unavailable",
    };
  }
  return snapshots;
}

async function cleanHarnessProcesses(
  environment: ResolvedAgentEnvironment,
  processNames: string[],
): Promise<void> {
  for (const name of processNames) {
    await guestOutput(environment, ["pkill", "-TERM", "-x", name]);
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await Deno.mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await Deno.writeTextFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await Deno.rename(temporary, path);
}

function clipText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const head = Math.floor(limit * 0.35);
  const tail = limit - head;
  return `${value.slice(0, head)}\n\n[... clipped by lm-tools ...]\n\n${value.slice(-tail)}`;
}

export function compactTurnTranscript(lines: string[], maxChars: number): string {
  const entries: string[] = [];
  for (const line of lines) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof event.type === "string" && event.type.startsWith("lm_tools.phase_")) {
      entries.push(JSON.stringify(event));
      continue;
    }
    if (event.method !== "item/completed") continue;
    const params = (event.params ?? {}) as Record<string, unknown>;
    const item = params.item as Record<string, unknown> | undefined;
    if (!item) continue;
    if (item.type === "agentMessage" && typeof item.text === "string") {
      entries.push(`ASSISTANT: ${item.text}`);
    } else if (item.type === "reasoning") {
      const summary = typeof item.summary === "string"
        ? item.summary
        : Array.isArray(item.summary)
        ? item.summary.filter((part) => typeof part === "string").join("\n")
        : "";
      if (summary) entries.push(`REASONING SUMMARY: ${summary}`);
    } else if (item.type === "commandExecution") {
      const command = typeof item.command === "string" ? item.command : "command";
      const output = typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : "";
      entries.push(`COMMAND: ${command}\n${clipText(output, 1800)}`);
    }
  }
  return clipText(entries.join("\n\n"), maxChars);
}

function fallbackTurnSummary(
  runId: string,
  exitCode: number,
  timedOut: boolean,
  finalMessage: string | null,
  phases: AttemptPhaseRun[] | undefined,
  stateChanged: boolean,
  error?: string,
): TurnResearchSummary {
  const phaseNames = phases?.map((phase) => phase.name).join(" → ") || "unphased turn";
  const outcome = exitCode === 0
    ? `Completed ${phaseNames}.`
    : timedOut
    ? `Timed out during ${phases?.at(-1)?.name ?? "the turn"}.`
    : `Stopped with exit code ${exitCode} during ${phases?.at(-1)?.name ?? "the turn"}.`;
  return {
    runId,
    generatedAt: new Date().toISOString(),
    source: "fallback",
    title: exitCode === 0 ? `Completed ${phaseNames}` : `Incomplete ${phaseNames}`,
    status: exitCode === 0 ? "progress" : "blocked",
    summary: finalMessage?.trim() || outcome,
    outcome,
    evidence:
      phases?.map((phase) =>
        `${phase.name}: ${
          phase.exitCode === 0
            ? "completed"
            : phase.timedOut
            ? "timed out"
            : `exit ${phase.exitCode}`
        }`
      ) ?? [],
    changes: [
      stateChanged ? "Durable campaign state changed." : "Durable campaign state was unchanged.",
    ],
    nextStep: exitCode === 0
      ? "Continue from the durable campaign state and latest handoff."
      : "Resume the interrupted phase from the durable campaign state.",
    ...(error ? { error } : {}),
  };
}

async function appendTurnSummary(
  path: string,
  environmentName: string,
  summary: TurnResearchSummary,
): Promise<void> {
  let ledger: TurnSummaryLedger | undefined;
  try {
    ledger = JSON.parse(await Deno.readTextFile(path)) as TurnSummaryLedger;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  ledger ??= {
    version: 1,
    environment: environmentName,
    updatedAt: summary.generatedAt,
    entries: [],
  };
  ledger.updatedAt = summary.generatedAt;
  ledger.entries = ledger.entries.filter((entry) => entry.runId !== summary.runId);
  ledger.entries.push(summary);
  await writeJsonAtomic(path, ledger);
}

async function generateTurnSummary(
  environment: ResolvedAgentEnvironment,
  input: {
    runId: string;
    exitCode: number;
    timedOut: boolean;
    finalMessage: string | null;
    phases: AttemptPhaseRun[] | undefined;
    stateBefore: string | null;
    stateAfter: string | null;
    state: string | null;
    repositoriesBefore: Record<string, RepositorySnapshot>;
    repositoriesAfter: Record<string, RepositorySnapshot>;
    lines: string[];
  },
): Promise<TurnResearchSummary | undefined> {
  const config = harnessConfig(environment).turnSummary;
  if (!config) return undefined;
  const fallback = (error?: string) =>
    fallbackTurnSummary(
      input.runId,
      input.exitCode,
      input.timedOut,
      input.finalMessage,
      input.phases,
      input.stateBefore !== input.stateAfter,
      error,
    );
  const facts = {
    runId: input.runId,
    exitCode: input.exitCode,
    timedOut: input.timedOut,
    phases: input.phases,
    stateChanged: input.stateBefore !== input.stateAfter,
    repositoriesBefore: input.repositoriesBefore,
    repositoriesAfter: input.repositoriesAfter,
    finalMessage: input.finalMessage,
  };
  const transcriptBudget = Math.max(2000, Math.floor(config.maxInputChars * 0.45));
  const stateBudget = Math.max(2000, Math.floor(config.maxInputChars * 0.35));
  const evidence = `RUN FACTS\n${JSON.stringify(facts, null, 2)}\n\n` +
    `DURABLE STATE AFTER TURN\n${clipText(input.state ?? "unavailable", stateBudget)}\n\n` +
    `SELECTED TURN EVENTS\n${compactTurnTranscript(input.lines, transcriptBudget)}`;
  const prompt = `You are the research recorder for an autonomous software research campaign. ` +
    `Summarize the completed harness turn from the supplied evidence. Be accurate and concrete: ` +
    `separate observed evidence from hypotheses, say when no implementation was made, preserve ` +
    `important measurements and failed approaches, and name the most useful next action. Do not ` +
    `continue the research or call tools. Return exactly one JSON object with keys: title, status, ` +
    `summary, outcome, evidence, changes, nextStep. status must be one of progress, blocked, ` +
    `falsified, measurement-requested, candidate-ready. evidence and changes must be arrays of ` +
    `short strings. summary should be a substantial 2-4 paragraph research narrative, not a chat ` +
    `sign-off.\n\n${clipText(evidence, config.maxInputChars)}`;
  try {
    const response = await fetch(config.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1,
        max_tokens: config.maxOutputTokens,
        reasoning_effort: config.reasoningEffort,
        chat_template_kwargs: { reasoning_effort: config.reasoningEffort },
      }),
      signal: AbortSignal.timeout(config.timeoutSeconds * 1000),
    });
    if (!response.ok) throw new Error(`summary endpoint returned HTTP ${response.status}`);
    const body = await response.json() as Record<string, unknown>;
    const choices = body.choices;
    const first = Array.isArray(choices)
      ? choices[0] as Record<string, unknown> | undefined
      : undefined;
    const message = first?.message as Record<string, unknown> | undefined;
    if (typeof message?.content !== "string") throw new Error("summary endpoint returned no text");
    return parseTurnResearchSummary(message.content, input.runId);
  } catch (error) {
    return fallback(error instanceof Error ? error.message : String(error));
  }
}

async function updateLedger(
  path: string,
  environmentName: string,
  run: AttemptRun,
): Promise<CampaignLedger> {
  let ledger: CampaignLedger | undefined;
  try {
    ledger = JSON.parse(await Deno.readTextFile(path)) as CampaignLedger;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  ledger ??= {
    version: 1,
    environment: environmentName,
    startedAt: run.startedAt,
    updatedAt: run.finishedAt,
    runs: 0,
    successfulRuns: 0,
    failedRuns: 0,
    wallSeconds: 0,
    usage: { ...ZERO_USAGE },
    compactions: 0,
    semanticCompactions: 0,
    compactionReminders: 0,
    history: [],
  };
  ledger.updatedAt = run.finishedAt;
  ledger.runs += 1;
  if (run.exitCode === 0) ledger.successfulRuns += 1;
  else ledger.failedRuns += 1;
  ledger.wallSeconds += run.durationSeconds;
  ledger.usage = addUsage(ledger.usage, run.usage);
  ledger.compactions = (ledger.compactions ?? 0) + run.compactions;
  ledger.semanticCompactions = (ledger.semanticCompactions ?? 0) + run.semanticCompactions;
  ledger.compactionReminders = (ledger.compactionReminders ?? 0) + run.compactionReminders;
  ledger.history.push(run);
  await writeJsonAtomic(path, ledger);
  return ledger;
}

function harnessConfig(environment: ResolvedAgentEnvironment): AttemptHarness {
  const harness = environment.config.harness;
  if (!harness || harness.kind !== "turn-loop") {
    throw new Error("This action requires a turn-loop harness");
  }
  return harness;
}

export async function runAttemptOnce(
  environment: ResolvedAgentEnvironment,
  options: { startPhase?: string } = {},
): Promise<{ run: AttemptRun; ledger: CampaignLedger }> {
  const harness = harnessConfig(environment);
  const started = new Date();
  const id = started.toISOString().replaceAll(":", "").replaceAll(".", "-");
  await Deno.mkdir(harness.metricsDirectory, { recursive: true });
  const eventLog = join(harness.metricsDirectory, `${id}.jsonl`);
  const currentPath = join(harness.metricsDirectory, "current.json");
  await writeJsonAtomic(currentPath, {
    id,
    status: "starting",
    startedAt: started.toISOString(),
    eventLog,
    prompt: harness.prompt,
    state: harness.state,
    adapter: harness.adapter,
  });
  const prompt = await guestOutput(environment, ["cat", harness.prompt]);
  if (prompt === null) throw new Error(`Could not read guest harness prompt: ${harness.prompt}`);
  const repositoriesBefore = await repositorySnapshots(
    environment,
    harness.progressRepositories,
  );
  const stateBefore = await stateHash(environment, harness.state);

  await writeJsonAtomic(currentPath, {
    id,
    status: "running",
    startedAt: started.toISOString(),
    eventLog,
    prompt: harness.prompt,
    state: harness.state,
    adapter: harness.adapter,
  });
  let result: { exitCode: number; timedOut: boolean; lines: string[] };
  let phaseRuns: AttemptPhaseRun[] | undefined;
  if (harness.adapter === "app-server" && harness.phases?.length) {
    const lines: string[] = [];
    phaseRuns = [];
    let exitCode = 0;
    let timedOut = false;
    let phaseIndex = options.startPhase
      ? harness.phases.findIndex((phase) => phase.name === options.startPhase)
      : 0;
    if (phaseIndex < 0) throw new Error(`Unknown harness start phase: ${options.startPhase}`);
    const phaseNames = harness.phases.map((phase) => phase.name);
    const phaseControl = harness.phaseControl;
    const finalPhaseIndex = phaseControl
      ? harness.phases.findIndex((phase) => phase.name === phaseControl.finalPhase)
      : -1;
    let transitions = 0;
    while (phaseIndex < harness.phases.length) {
      if (
        phaseControl && phaseIndex !== finalPhaseIndex &&
        ((Date.now() - started.getTime()) / 1000 >= phaseControl.maxWallSeconds ||
          transitions >= phaseControl.maxTransitions)
      ) {
        const forcedEvent = {
          type: "lm_tools.phase_final_handoff_forced",
          reason: transitions >= phaseControl.maxTransitions ? "transition-limit" : "wall-limit",
          transitions,
          elapsedSeconds: (Date.now() - started.getTime()) / 1000,
          finalPhase: phaseControl.finalPhase,
        };
        await appendSyntheticEvent(eventLog, forcedEvent);
        lines.push(JSON.stringify(forcedEvent));
        phaseIndex = finalPhaseIndex;
      }
      const phase = harness.phases[phaseIndex];
      const phasePrompt = await guestOutput(environment, ["cat", phase.prompt]);
      if (phasePrompt === null) {
        throw new Error(`Could not read guest phase prompt: ${phase.prompt}`);
      }
      const before = Object.fromEntries(
        await Promise.all(
          phase.requiredChangedFiles.map(async (path) =>
            [path, await guestFileHash(environment, path)] as const
          ),
        ),
      );
      const phaseStarted = new Date();
      await writeJsonAtomic(currentPath, {
        id,
        status: "running",
        phase: phase.name,
        startedAt: started.toISOString(),
        phaseStartedAt: phaseStarted.toISOString(),
        eventLog,
        prompt: phase.prompt,
        state: harness.state,
        adapter: harness.adapter,
      });
      const phaseEvent = JSON.stringify({
        type: "lm_tools.phase_started",
        phase: phase.name,
        timeoutSeconds: phase.timeoutSeconds,
        requiredChangedFiles: phase.requiredChangedFiles,
      });
      await appendSyntheticEvent(eventLog, JSON.parse(phaseEvent));
      lines.push(phaseEvent);
      const phaseResult = await runAppServerTurn(
        environment,
        `${prompt}\n\n${phasePrompt}`,
        eventLog,
        {
          timeoutSeconds: phase.timeoutSeconds,
          wrapUpSeconds: phase.wrapUpSeconds,
          appendEventLog: true,
        },
      );
      lines.push(...phaseResult.lines);
      let unchanged: string[] = [];
      for (const path of phase.requiredChangedFiles) {
        const after = await guestFileHash(environment, path);
        if (after === null || after === before[path]) unchanged.push(path);
      }
      let finalizationAttempted = false;
      let finalizationResult: { exitCode: number; timedOut: boolean; lines: string[] } | undefined;
      if (
        phase.finalizeTimeoutSeconds &&
        (phaseResult.exitCode !== 0 || unchanged.length > 0)
      ) {
        finalizationAttempted = true;
        const startedEvent = JSON.stringify({
          type: "lm_tools.phase_finalization_started",
          phase: phase.name,
          timeoutSeconds: phase.finalizeTimeoutSeconds,
          unchangedRequiredFiles: unchanged,
        });
        await appendSyntheticEvent(eventLog, JSON.parse(startedEvent));
        lines.push(startedEvent);
        await writeJsonAtomic(currentPath, {
          id,
          status: "running",
          phase: `${phase.name}:finalize`,
          startedAt: started.toISOString(),
          phaseStartedAt: phaseStarted.toISOString(),
          eventLog,
          prompt: phase.prompt,
          state: harness.state,
          adapter: harness.adapter,
        });
        const required = phase.requiredChangedFiles.map((path) => `- ${path}`).join("\n");
        const finalizationPrompt = `${prompt}\n\n${phasePrompt}\n\n` +
          `[lm-tools forced phase finalization]\nThe work thread ended before this phase was ` +
          `durably complete. Do not investigate, calculate, profile, edit production source, or ` +
          `start new work. Inspect only the existing workspace artifacts needed to finish the ` +
          `phase. Immediately write or update every required file below so it records the best ` +
          `current conclusion, even if provisional:\n${required}\nAfter verifying those files exist ` +
          `and are valid, end the turn.`;
        finalizationResult = await runAppServerTurn(
          environment,
          finalizationPrompt,
          eventLog,
          {
            timeoutSeconds: phase.finalizeTimeoutSeconds,
            wrapUpSeconds: Math.max(30, Math.floor(phase.finalizeTimeoutSeconds * 2 / 3)),
            appendEventLog: true,
          },
        );
        lines.push(...finalizationResult.lines);
        unchanged = [];
        for (const path of phase.requiredChangedFiles) {
          const after = await guestFileHash(environment, path);
          if (after === null || after === before[path]) unchanged.push(path);
        }
        const completedFinalizationEvent = JSON.stringify({
          type: "lm_tools.phase_finalization_completed",
          phase: phase.name,
          exitCode: finalizationResult.exitCode,
          timedOut: finalizationResult.timedOut,
          unchangedRequiredFiles: unchanged,
        });
        await appendSyntheticEvent(eventLog, JSON.parse(completedFinalizationEvent));
        lines.push(completedFinalizationEvent);
      }
      const phaseFinished = new Date();
      const effectiveResult = finalizationResult ?? phaseResult;
      const phaseExitCode = effectiveResult.exitCode === 0 && unchanged.length === 0
        ? 0
        : effectiveResult.exitCode || 2;
      const phaseTimedOut = phaseExitCode === 0
        ? false
        : phaseResult.timedOut || (finalizationResult?.timedOut ?? false);
      const completedEvent = JSON.stringify({
        type: "lm_tools.phase_completed",
        phase: phase.name,
        exitCode: phaseExitCode,
        timedOut: phaseTimedOut,
        workTimedOut: phaseResult.timedOut,
        finalizationAttempted,
        unchangedRequiredFiles: unchanged,
      });
      await appendSyntheticEvent(eventLog, JSON.parse(completedEvent));
      lines.push(completedEvent);
      phaseRuns.push({
        name: phase.name,
        startedAt: phaseStarted.toISOString(),
        finishedAt: phaseFinished.toISOString(),
        durationSeconds: (phaseFinished.getTime() - phaseStarted.getTime()) / 1000,
        exitCode: phaseExitCode,
        timedOut: phaseTimedOut,
        workTimedOut: phaseResult.timedOut,
        finalizationAttempted,
        requiredChangedFiles: phase.requiredChangedFiles,
      });
      if (phaseExitCode !== 0) {
        exitCode = phaseExitCode;
        timedOut = phaseTimedOut;
        break;
      }
      if (phaseControl && phase.name === phaseControl.finalPhase) break;
      const requested = phaseControl
        ? await readAttemptPhaseRequest(environment, phaseControl.requestPath, phaseNames)
        : undefined;
      const nextIndex = requested
        ? harness.phases.findIndex((candidate) => candidate.name === requested.next)
        : phaseIndex + 1;
      if (requested) {
        const transitionEvent = {
          type: "lm_tools.phase_transition_requested",
          from: phase.name,
          to: requested.next,
          reason: requested.reason,
        };
        await appendSyntheticEvent(eventLog, transitionEvent);
        lines.push(JSON.stringify(transitionEvent));
      }
      phaseIndex = nextIndex;
      transitions += 1;
    }
    result = { exitCode, timedOut, lines };
  } else {
    result = harness.adapter === "app-server"
      ? await runAppServerTurn(environment, prompt, eventLog)
      : harness.adapter === "pi-rpc"
      ? await runPiRpcTurn(environment, prompt, eventLog)
      : harness.adapter === "omp-rpc"
      ? await runOmpRpcTurn(environment, prompt, eventLog, { attemptId: id })
      : await runExecJsonTurn(environment, prompt, eventLog);
  }
  await cleanHarnessProcesses(environment, harness.cleanupProcesses);
  const parsed = harness.adapter === "pi-rpc"
    ? parsePiRpcEvents(result.lines)
    : harness.adapter === "omp-rpc"
    ? parseOmpRpcEvents(result.lines)
    : parseCodexEventUsage(result.lines);
  const stateAfter = await stateHash(environment, harness.state);
  const repositoriesAfter = await repositorySnapshots(environment, harness.progressRepositories);
  let summary: TurnResearchSummary | undefined;
  if (harness.turnSummary) {
    await writeJsonAtomic(currentPath, {
      id,
      status: "summarizing",
      startedAt: started.toISOString(),
      eventLog,
      state: harness.state,
      adapter: harness.adapter,
    });
    summary = await generateTurnSummary(environment, {
      runId: id,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      finalMessage: parsed.finalMessage,
      phases: phaseRuns,
      stateBefore,
      stateAfter,
      state: await guestOutput(environment, ["cat", harness.state]),
      repositoriesBefore,
      repositoriesAfter,
      lines: result.lines,
    });
    if (summary) {
      try {
        await appendTurnSummary(
          join(harness.metricsDirectory, "summaries.json"),
          environment.config.name,
          summary,
        );
      } catch (error) {
        console.error(`Could not record turn summary for ${id}: ${error}`);
      }
    }
  }
  const finished = new Date();
  const run: AttemptRun = {
    id,
    startedAt: started.toISOString(),
    finishedAt: finished.toISOString(),
    durationSeconds: (finished.getTime() - started.getTime()) / 1000,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    usage: parsed.usage,
    compactions: parsed.compactions,
    semanticCompactions: parsed.semanticCompactions,
    compactionReminders: parsed.compactionReminders,
    eventLog,
    stateBefore,
    stateAfter,
    repositoriesBefore,
    repositoriesAfter,
    finalMessage: parsed.finalMessage,
    summary,
    phases: phaseRuns,
  };
  await writeJsonAtomic(join(harness.metricsDirectory, `${id}.json`), run);
  const ledger = await updateLedger(
    join(harness.metricsDirectory, "campaign.json"),
    environment.config.name,
    run,
  );
  await writeJsonAtomic(currentPath, {
    id,
    status: "finished",
    startedAt: started.toISOString(),
    finishedAt: finished.toISOString(),
    exitCode: run.exitCode,
    eventLog,
    report: join(harness.metricsDirectory, `${id}.json`),
  });
  return { run, ledger };
}

export async function runAttemptLoop(environment: ResolvedAgentEnvironment): Promise<never> {
  const harness = harnessConfig(environment);
  while (true) {
    try {
      const { run, ledger } = await runAttemptOnce(environment);
      console.log(
        `Attempt ${run.id}: exit=${run.exitCode}, ${run.durationSeconds.toFixed(1)}s, ` +
          `${
            run.usage.totalTokens.toLocaleString("en-US")
          } tokens, ${run.compactions} compactions (${run.semanticCompactions} model-directed, ` +
          `${run.compactionReminders} reminders); campaign ` +
          `${ledger.runs} runs / ${ledger.usage.totalTokens.toLocaleString("en-US")} tokens`,
      );
      if (run.finalMessage) console.log(run.finalMessage.trim());
    } catch (error) {
      console.error(`Attempt failed before it could be recorded: ${error}`);
    }
    await new Promise((resolve) => setTimeout(resolve, harness.cooldownSeconds * 1000));
  }
}
