import {
  assertEquals,
  assertExists,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1";
import { join } from "jsr:@std/path@1";
import { loadFreeRouterConfig } from "./free_router_server.ts";
import type { FreeRouterModelConfig } from "./free_router_server.ts";
import {
  ompTaskUsage,
  parseOmpTaskArgs,
  resolveOmpTaskPrompt,
  runOmpTask,
  taskCommand,
} from "./omp_task.ts";

function freePort(): number {
  return 20000 + Math.floor(Math.random() * 30000);
}

const FREE_MODEL: FreeRouterModelConfig = {
  id: "free-auto",
  contextLength: 131072,
  maxOutputTokens: 8192,
  offers: [{
    id: "nvidia-glm-5.3-flash",
    adapter: "omp",
    provider: "nvidia",
    model: "z-ai/glm-5.3-flash",
    accessClass: "free",
    pricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
    priority: 0,
  }],
};

const PAID_ONLY_MODEL: FreeRouterModelConfig = {
  id: "free-auto",
  contextLength: 131072,
  maxOutputTokens: 8192,
  offers: [{
    id: "paid-route",
    adapter: "omp",
    provider: "nvidia",
    model: "paid-model",
    accessClass: "paid",
    pricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
  }],
};

/** A fake `omp` that records its argv and environment, emits json-mode events, and exits 0. */
async function writeFakeOmp(
  directory: string,
  script: string,
): Promise<string> {
  const path = join(directory, "fake-omp");
  await Deno.writeTextFile(path, script);
  await Deno.chmod(path, 0o755);
  return path;
}

const EVENT_SCRIPT = `#!/bin/sh
set -eu
printf '%s\\n' "$0 $*" > "$RECORD_PATH"
cat > /dev/null
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","usage":{"input":10,"cacheRead":4,"output":5,"totalTokens":19},"content":[{"type":"text","text":"the final answer"}]}}'
printf '%s\\n' '{"type":"agent_end","isTerminal":true}'
`;

const SLEEP_SCRIPT = `#!/bin/sh
trap 'printf killed > "$RECORD_PATH"; exit 143' TERM
cat > /dev/null
sleep 120 &
wait $!
`;

async function writeRouterConfig(
  directory: string,
  model: FreeRouterModelConfig,
  listen: { host: string; port: number },
): Promise<string> {
  const path = join(directory, "free-router.json");
  await Deno.writeTextFile(
    path,
    JSON.stringify({
      version: 1,
      listen,
      omp: { baseUrl: "http://127.0.0.1:4000" },
      models: [model],
    }),
  );
  return path;
}

Deno.test("parseOmpTaskArgs accepts a well-formed free invocation", () => {
  const parsed = parseOmpTaskArgs([
    "--profile",
    "free",
    "--cwd",
    "/tmp/project",
    "--router-config",
    "/tmp/free-router.json",
    "--prompt",
    "review this",
    "--timeout-seconds",
    "30",
    "--json",
  ]);
  assertEquals(parsed.profile, "free");
  assertEquals(parsed.cwd, "/tmp/project");
  assertEquals(parsed.routerConfig, "/tmp/free-router.json");
  assertEquals(parsed.prompt, "review this");
  assertEquals(parsed.timeoutSeconds, 30);
  assertEquals(parsed.json, true);
});

Deno.test("parseOmpTaskArgs rejects missing, unknown, and conflicting input", () => {
  assertThrows(() => parseOmpTaskArgs(["--cwd", "/tmp"]), Error, "--profile");
  assertThrows(
    () => parseOmpTaskArgs(["--profile", "cheap", "--cwd", "/tmp"]),
    Error,
    "Unknown task profile",
  );
  assertThrows(() => parseOmpTaskArgs(["--profile", "paid"]), Error, "--cwd");
  assertThrows(
    () =>
      parseOmpTaskArgs([
        "--profile",
        "paid",
        "--cwd",
        "/tmp",
        "--prompt",
        "a",
        "--prompt-file",
        "/tmp/p",
      ]),
    Error,
    "mutually exclusive",
  );
  assertThrows(
    () => parseOmpTaskArgs(["--profile", "paid", "--cwd", "/tmp", "--frob"]),
    Error,
    "Unknown task option",
  );
});

Deno.test("parseOmpTaskArgs enforces profile/router-config boundaries", () => {
  assertThrows(
    () => parseOmpTaskArgs(["--profile", "free", "--cwd", "/tmp"]),
    Error,
    "--router-config",
  );
  assertThrows(
    () =>
      parseOmpTaskArgs([
        "--profile",
        "paid",
        "--cwd",
        "/tmp",
        "--router-config",
        "/tmp/free-router.json",
      ]),
    Error,
    "must not be routed through a free router",
  );
});

Deno.test("prompt resolution enforces precedence, missing files, and empty prompts", async () => {
  const directory = await Deno.makeTempDir();
  const promptPath = join(directory, "prompt.md");
  await Deno.writeTextFile(promptPath, "from file\n");
  assertEquals(await resolveOmpTaskPrompt({ prompt: "inline" }), "inline");
  assertEquals(await resolveOmpTaskPrompt({ promptFile: promptPath }), "from file\n");
  assertEquals(await resolveOmpTaskPrompt({}, "from stdin"), "from stdin");
  await assertRejects(() => resolveOmpTaskPrompt({}, undefined), Error, "required");
  await assertRejects(() => resolveOmpTaskPrompt({ prompt: "  \n" }), Error, "empty");
  await assertRejects(() => resolveOmpTaskPrompt({ promptFile: join(directory, "missing") }));
  await Deno.remove(directory, { recursive: true });
});

Deno.test("a paid task runs plain OMP and never starts a router", async () => {
  const directory = await Deno.makeTempDir();
  const cwd = join(directory, "project");
  await Deno.mkdir(cwd);
  const recordPath = join(directory, "record.txt");
  const fake = await writeFakeOmp(directory, EVENT_SCRIPT);
  const result = await runOmpTask({
    profile: "paid",
    cwd,
    prompt: "implement the thing",
    ompExecutable: fake,
    environment: { RECORD_PATH: recordPath },
    timeoutMs: 60_000,
  });
  assertEquals(result.termination, { kind: "completed", exitCode: 0 });
  assertEquals(result.text, "the final answer");
  assertEquals(result.usage, {
    inputTokens: 10,
    cachedInputTokens: 4,
    outputTokens: 5,
    totalTokens: 19,
  });
  assertEquals(result.route, null);
  assertEquals(result.router, null);
  assertEquals(result.paths.ompAgentDirectory, undefined);
  const record = await Deno.readTextFile(recordPath);
  assertStringIncludes(record, "--mode json");
  assertStringIncludes(record, "--session-dir");
  assertEquals(record.includes("--model"), false);
  // No router artifacts beneath the task directory.
  const entries = [];
  for await (const entry of Deno.readDir(result.taskDirectory)) entries.push(entry.name);
  assertEquals(
    entries.sort(),
    ["events.jsonl", "stderr.log", "task-result.json"],
  );
  await Deno.remove(directory, { recursive: true });
});

Deno.test("a free task isolates its agent directory, owns a router session, and records its lane", async () => {
  const directory = await Deno.makeTempDir();
  const cwd = join(directory, "project");
  await Deno.mkdir(cwd);
  const recordPath = join(directory, "record.txt");
  const fake = await writeFakeOmp(directory, EVENT_SCRIPT);
  const configPath = await writeRouterConfig(directory, FREE_MODEL, {
    host: "127.0.0.1",
    port: freePort(),
  });
  const config = await loadFreeRouterConfig(configPath);
  const result = await runOmpTask({
    profile: "free",
    cwd,
    prompt: "review this",
    routerConfig: configPath,
    ompExecutable: fake,
    environment: { RECORD_PATH: recordPath },
    timeoutMs: 60_000,
  });
  assertEquals(result.termination, { kind: "completed", exitCode: 0 });
  assertEquals(result.text, "the final answer");
  assertExists(result.router);
  assertExists(result.router!.readyAt);
  // The task shut its own router down; the port is free again.
  assertEquals(result.router!.shutdown?.reason, "explicit");
  const listener = await Deno.listen(config.listen);
  listener.close();
  // The isolated agent directory carries only the credential-free lane.
  const modelsYml = await Deno.readTextFile(join(result.paths.ompAgentDirectory!, "models.yml"));
  assertStringIncludes(modelsYml, "free-auto");
  assertEquals(modelsYml.includes("nvidia-glm-5.3-flash"), false);
  assertEquals(modelsYml.toLowerCase().includes("bearer"), false);
  // No completed traffic: the fake OMP never called the router, so no route.
  assertEquals(result.route, null);
  // The record shows the router lane was selected as the model.
  const record = await Deno.readTextFile(recordPath);
  assertStringIncludes(record, "--model free-auto");
  await Deno.remove(directory, { recursive: true });
});

Deno.test("a free task fails closed when no lane is eligible and never launches OMP", async () => {
  const directory = await Deno.makeTempDir();
  const cwd = join(directory, "project");
  await Deno.mkdir(cwd);
  const recordPath = join(directory, "record.txt");
  const fake = await writeFakeOmp(
    directory,
    `#!/bin/sh
printf '%s\\n' "$0 $*" > "$RECORD_PATH"
`,
  );
  const configPath = await writeRouterConfig(directory, PAID_ONLY_MODEL, {
    host: "127.0.0.1",
    port: freePort(),
  });
  const error = await assertRejects(
    () =>
      runOmpTask({
        profile: "free",
        cwd,
        prompt: "review this",
        routerConfig: configPath,
        ompExecutable: fake,
        environment: { RECORD_PATH: recordPath },
        timeoutMs: 60_000,
      }),
    Error,
    "did not become ready",
  );
  assertStringIncludes(error.message, "did not become ready");
  // Fail closed: OMP was never started, so there is no paid fallback either.
  const record = await Deno.readTextFile(recordPath).catch(() => null);
  assertEquals(record, null);
  // The failed session released its port.
  const config = await loadFreeRouterConfig(configPath);
  const listener = await Deno.listen(config.listen);
  listener.close();
  await Deno.remove(directory, { recursive: true });
});

Deno.test("task usage documents the profile and fail-closed contract", () => {
  const usage = ompTaskUsage();
  assertStringIncludes(usage, "--profile free|paid");
  assertStringIncludes(usage, "--router-config PATH");
  assertStringIncludes(usage, "--json");
  assertStringIncludes(usage, "fail");
});

Deno.test("cancellation kills OMP and shuts the router down as cancelled", async () => {
  const directory = await Deno.makeTempDir();
  const cwd = join(directory, "project");
  await Deno.mkdir(cwd);
  const recordPath = join(directory, "record.txt");
  const fake = await writeFakeOmp(directory, SLEEP_SCRIPT);
  const configPath = await writeRouterConfig(directory, FREE_MODEL, {
    host: "127.0.0.1",
    port: freePort(),
  });
  const controller = new AbortController();
  const task = runOmpTask({
    profile: "free",
    cwd,
    prompt: "review this",
    routerConfig: configPath,
    ompExecutable: fake,
    environment: { RECORD_PATH: recordPath },
    timeoutMs: 120_000,
    signal: controller.signal,
  });
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 400);
  await promise;
  controller.abort();
  const result = await task;
  assertEquals(result.termination.kind, "cancelled");
  assertEquals(result.router?.shutdown?.reason, "cancelled");
  // The fake OMP saw SIGTERM.
  assertEquals((await Deno.readTextFile(recordPath)).trim(), "killed");
  await Deno.remove(directory, { recursive: true });
});

Deno.test("timeout terminates the OMP process and records a timeout termination", async () => {
  const directory = await Deno.makeTempDir();
  const cwd = join(directory, "project");
  await Deno.mkdir(cwd);
  const recordPath = join(directory, "record.txt");
  const fake = await writeFakeOmp(directory, SLEEP_SCRIPT);
  const result = await runOmpTask({
    profile: "paid",
    cwd,
    prompt: "implement the thing",
    ompExecutable: fake,
    environment: { RECORD_PATH: recordPath },
    timeoutMs: 500,
  });
  assertEquals(result.termination.kind, "timeout");
  assertEquals(result.text, null);
  assertEquals((await Deno.readTextFile(recordPath)).trim(), "killed");
  await Deno.remove(directory, { recursive: true });
});

Deno.test("JSON mode prints the envelope; plain mode prints only the answer", async () => {
  const directory = await Deno.makeTempDir();
  const cwd = join(directory, "project");
  await Deno.mkdir(cwd);
  const outputs: string[] = [];
  const fake = await writeFakeOmp(
    directory,
    `#!/bin/sh
cat > /dev/null
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","usage":{"input":10,"cacheRead":4,"output":5,"totalTokens":19},"content":[{"type":"text","text":"the final answer"}]}}'
printf '%s\n' '{"type":"agent_end","isTerminal":true}'
`,
  );
  Deno.env.set("LM_TOOLS_OMP_EXECUTABLE", fake);
  const originalLog = console.log;
  console.log = (message?: unknown) => {
    outputs.push(String(message));
  };
  try {
    await taskCommand([
      "--profile",
      "paid",
      "--cwd",
      cwd,
      "--prompt",
      "implement the thing",
      "--json",
    ]);
  } finally {
    console.log = originalLog;
    Deno.env.delete("LM_TOOLS_OMP_EXECUTABLE");
  }
  const envelope = JSON.parse(outputs[0]!) as {
    profile: string;
    text: string | null;
    termination: { kind: string };
    usage: { totalTokens: number };
    router: unknown;
  };
  assertEquals(envelope.profile, "paid");
  assertEquals(envelope.text, "the final answer");
  assertEquals(envelope.termination.kind, "completed");
  assertEquals(envelope.usage.totalTokens, 19);
  assertEquals(envelope.router, null);
  await Deno.remove(directory, { recursive: true });
});
