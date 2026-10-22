type JsonObject = Record<string, unknown>;
import { assertEquals } from "jsr:@std/assert@1/equals";
import {
  adaptReasoningEvent,
  adaptReasoningStream,
  InferenceTracker,
  normalizeRequestBody,
  observeStream,
  proxyTraceRequestEvents,
  proxyTraceResponseEvents,
  serveProxy,
} from "./proxy.ts";

Deno.test("passes Codex discovery and health GETs through without request bodies", async () => {
  const seen: Array<{ method: string; path: string }> = [];
  const upstreamAbort = new AbortController();
  const upstream = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    signal: upstreamAbort.signal,
    onListen() {},
  }, (request) => {
    const url = new URL(request.url);
    seen.push({ method: request.method, path: url.pathname });
    if (url.pathname === "/health") return Response.json({ status: "ok" });
    return Response.json({ object: "list", data: [{ id: "qwen3.8-27b" }] });
  });
  const upstreamPort = (upstream.addr as Deno.NetAddr).port;
  const proxyAbort = new AbortController();
  const server = serveProxy({
    listenHost: "127.0.0.1",
    listenPort: 0,
    upstream: new URL(`http://127.0.0.1:${upstreamPort}`),
  }, proxyAbort.signal);
  const proxyPort = (server.addr as Deno.NetAddr).port;
  try {
    const health = await fetch(`http://127.0.0.1:${proxyPort}/health`);
    assertEquals(await health.json(), { status: "ok" });
    const models = await fetch(`http://127.0.0.1:${proxyPort}/v1/models`);
    assertEquals(await models.json(), {
      object: "list",
      data: [{ id: "qwen3.8-27b" }],
    });
    assertEquals(seen, [
      { method: "GET", path: "/health" },
      { method: "GET", path: "/v1/models" },
    ]);
  } finally {
    proxyAbort.abort();
    upstreamAbort.abort();
    await Promise.all([server.finished, upstream.finished]);
  }
});

Deno.test("normalizes empty function parameters", () => {
  const input = {
    tools: [
      { type: "function", name: "empty", parameters: {} },
      { type: "function", name: "valid", parameters: { type: "object" } },
    ],
  };
  assertEquals(normalizeRequestBody(input), {
    fixes: 1,
    changes: ["normalized 1 empty tool schema(s)"],
    body: {
      tools: [
        {
          type: "function",
          name: "empty",
          parameters: { type: "object", properties: {}, additionalProperties: false },
        },
        { type: "function", name: "valid", parameters: { type: "object" } },
      ],
    },
  });
});

Deno.test("preserves Responses API image inputs", () => {
  const input = {
    model: "qwen3.8-27b",
    input: [{
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "Describe this image." },
        { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgo=" },
      ],
    }],
  };
  assertEquals(normalizeRequestBody(input), { body: input, fixes: 0, changes: [] });
});

Deno.test("lifts images out of llama.cpp-incompatible function outputs", () => {
  const image = { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgo=" };
  assertEquals(
    normalizeRequestBody({
      model: "qwen3.8-27b",
      input: [{
        type: "function_call_output",
        call_id: "call_browser_screenshot",
        output: [
          { type: "input_text", text: "Screenshot captured." },
          image,
        ],
      }],
    }),
    {
      fixes: 1,
      changes: ["normalized 1 array tool output(s), lifting 1 image(s)"],
      body: {
        model: "qwen3.8-27b",
        input: [
          {
            type: "function_call_output",
            call_id: "call_browser_screenshot",
            output: "Screenshot captured.",
          },
          {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Image output from tool call call_browser_screenshot.",
              },
              image,
            ],
          },
        ],
      },
    },
  );
});

Deno.test("anchors tool schema patterns for llama.cpp without narrowing substring matches", () => {
  const input = {
    tools: [{
      type: "function",
      name: "cron",
      parameters: {
        type: "object",
        properties: {
          declarationKey: { type: "string", pattern: "\\S" },
          fixed: { type: "string", pattern: "^[a-z]+$" },
          prefix: { type: "string", pattern: "^job-" },
        },
      },
    }],
  };
  assertEquals(normalizeRequestBody(input), {
    fixes: 2,
    changes: ["anchored 2 tool schema pattern(s)"],
    body: {
      tools: [{
        type: "function",
        name: "cron",
        parameters: {
          type: "object",
          properties: {
            declarationKey: { type: "string", pattern: "^.*(?:[^ \\t\\r\\n]).*$" },
            fixed: { type: "string", pattern: "^[a-z]+$" },
            prefix: { type: "string", pattern: "^(?:^job-).*$" },
          },
        },
      }],
    },
  });
});

Deno.test("removes unsupported Responses API continuation state", () => {
  assertEquals(
    normalizeRequestBody({
      model: "qwen",
      previous_response_id: "resp_123",
      input: [{ type: "function_call_output", call_id: "call_1", output: "done" }],
    }),
    {
      fixes: 1,
      changes: ["removed previous_response_id"],
      body: {
        model: "qwen",
        input: [{ type: "function_call_output", call_id: "call_1", output: "done" }],
      },
    },
  );
});

Deno.test("maps Responses reasoning effort into model template kwargs", () => {
  assertEquals(
    normalizeRequestBody(
      {
        model: "qwen",
        reasoning: { effort: "high" },
        chat_template_kwargs: { preserve_thinking: true },
      },
      { high: "xhigh" },
    ),
    {
      fixes: 1,
      changes: ["mapped reasoning effort high to template value xhigh"],
      body: {
        model: "qwen",
        reasoning: { effort: "xhigh" },
        chat_template_kwargs: { preserve_thinking: true, reasoning_effort: "xhigh" },
      },
    },
  );
  assertEquals(normalizeRequestBody({ reasoning: { effort: "none" } }, { none: "none" }), {
    fixes: 0,
    changes: [],
    body: { reasoning: { effort: "none" } },
  });
});

Deno.test("folds leading Codex developer messages into system instructions", () => {
  assertEquals(
    normalizeRequestBody({
      instructions: "Base system prompt",
      input: [
        {
          type: "message",
          role: "developer",
          content: [
            { type: "input_text", text: "Repository instructions" },
            { type: "input_text", text: "Environment instructions" },
          ],
        },
        { type: "message", role: "user", content: "Do the task" },
      ],
    }),
    {
      fixes: 1,
      changes: ["folded 1 leading developer message(s) into instructions"],
      body: {
        instructions: "Base system prompt\n\nRepository instructions\n\nEnvironment instructions",
        input: [{ type: "message", role: "user", content: "Do the task" }],
      },
    },
  );
});

Deno.test("removes proxy-generated system reasoning from model input", () => {
  assertEquals(
    normalizeRequestBody({
      input: [
        {
          type: "reasoning",
          id: "lm-tools-system-reasoning-prompt-evaluation-123",
          status: "completed",
          summary: [{
            type: "summary_text",
            text: "Evaluating prompt…\nPrompt evaluation: 100% (8,192 tokens)\n",
          }],
        },
        {
          type: "reasoning",
          id: "rs_model",
          text:
            "Evaluating prompt…\nPrompt evaluation: 50% (4,096 tokens)\nPrompt evaluation: 100% (8,192 tokens)\nActual model reasoning",
        },
        { role: "user", content: "Keep this" },
      ],
    }),
    {
      // The surviving user item is also given an explicit type: llama.cpp
      // rejects untyped items outright.
      fixes: 3,
      changes: [
        "removed 2 system reasoning trace artifact(s)",
        "typed 1 untyped input item(s) as message",
      ],
      body: {
        input: [
          { type: "reasoning", id: "rs_model", text: "Actual model reasoning" },
          { type: "message", role: "user", content: "Keep this" },
        ],
      },
    },
  );
});

Deno.test("adapts reasoning deltas for VS Code", () => {
  assertEquals(
    adaptReasoningEvent({
      type: "response.reasoning_text.delta",
      output_index: 0,
      content_index: 0,
      delta: "Thinking",
    }),
    {
      type: "response.reasoning_summary_text.delta",
      output_index: 0,
      summary_index: 0,
      delta: "Thinking",
    },
  );
});

Deno.test("synthesizes the complete reasoning summary stream lifecycle", async () => {
  const input = [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { id: "rs_1", type: "reasoning", summary: [], content: [] },
    },
    {
      type: "response.reasoning_text.delta",
      item_id: "rs_1",
      output_index: 0,
      content_index: 0,
      delta: "Visible thought",
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        id: "rs_1",
        type: "reasoning",
        summary: [],
        content: [{ type: "reasoning_text", text: "Visible thought" }],
      },
    },
  ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");

  const source = new Response(input).body;
  if (!source) throw new Error("test stream unavailable");
  const output = await new Response(adaptReasoningStream(source)).text();
  const eventTypes = [...output.matchAll(/^event: (.+)$/gm)].map((match) => match[1]);

  assertEquals(eventTypes, [
    "response.output_item.added",
    "response.reasoning_summary_part.added",
    "response.reasoning_summary_text.delta",
    "response.reasoning_summary_text.done",
    "response.reasoning_summary_part.done",
    "response.output_item.done",
  ]);
  assertEquals(output.includes('"text":"Visible thought"'), true);
});

Deno.test("streams real prompt evaluation progress as local reasoning", async () => {
  let progress = { taskId: 55, tokens: 8192, progress: 0.38 };
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(
        'event: response.created\ndata: {"type":"response.created"}\n\n',
      ));
      setTimeout(() => {
        progress = { taskId: 55, tokens: 9216, progress: 0.43 };
      }, 50);
      setTimeout(() => {
        controller.enqueue(new TextEncoder().encode(
          'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Done"}\n\n',
        ));
        controller.close();
      }, 300);
    },
  });

  const output = await new Response(adaptReasoningStream(input, () => progress)).text();
  assertEquals(output.includes("Evaluating prompt…"), true);
  assertEquals(output.includes("Prompt evaluation: 43% (9,216 tokens)"), true);
  const events = [...output.matchAll(/^data: (.+)$/gm)].map((match) => JSON.parse(match[1]));
  const synthetic = events.filter((event) => event.output_index === -1);
  assertEquals(synthetic.map((event) => event.type), [
    "response.output_item.added",
    "response.reasoning_summary_part.added",
    "response.reasoning_summary_text.delta",
    "response.reasoning_summary_text.delta",
    "response.reasoning_summary_text.done",
    "response.reasoning_summary_part.done",
    "response.output_item.done",
  ]);
  assertEquals(synthetic[0].item.id, synthetic[6].item.id);
  assertEquals(
    synthetic[6].item.id.startsWith("lm-tools-system-reasoning-prompt-evaluation-"),
    true,
  );
  assertEquals(synthetic[6].item.summary[0].text.includes("Prompt evaluation: 43%"), true);
});

Deno.test("observes completed response usage without changing the stream", async () => {
  const completed = {
    type: "response.completed",
    response: {
      id: "resp_local",
      usage: { input_tokens: 1200, output_tokens: 80, total_tokens: 1280 },
      output: [],
    },
  };
  const input = new Response(
    `event: response.completed\ndata: ${JSON.stringify(completed)}\n\n`,
  ).body;
  if (!input) throw new Error("test stream unavailable");
  const observed: Record<string, unknown>[] = [];
  const output = await new Response(adaptReasoningStream(input, undefined, (event) => {
    observed.push(event);
  })).text();
  assertEquals(observed, [completed]);
  assertEquals(output.includes('"total_tokens":1280'), true);
});

Deno.test("normalizes Responses tool calls and results into proxy-native timeline events", () => {
  assertEquals(
    proxyTraceResponseEvents({
      type: "response.output_item.done",
      item: {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: "exec",
        arguments: '{"command":"pwd"}',
      },
    }),
    [{
      method: "item/started",
      item: {
        id: "call_1",
        type: "commandExecution",
        command: "pwd",
        aggregatedOutput: "",
      },
    }],
  );
  assertEquals(
    proxyTraceRequestEvents({
      input: [{
        type: "function_call_output",
        call_id: "call_1",
        output: '{"details":{"exitCode":7},"content":"failed"}',
      }],
    }),
    [{
      method: "item/completed",
      item: {
        id: "call_1",
        type: "commandExecution",
        aggregatedOutput: '{"details":{"exitCode":7},"content":"failed"}',
        exitCode: 7,
      },
    }],
  );
});

Deno.test("normalizes live Responses assistant and reasoning deltas", () => {
  assertEquals(
    proxyTraceResponseEvents({
      type: "response.output_text.delta",
      item_id: "msg_1",
      delta: "hello",
    }),
    [{ method: "item/agentMessage/delta", params: { itemId: "msg_1", delta: "hello" } }],
  );
  assertEquals(
    proxyTraceResponseEvents({
      type: "response.reasoning_text.delta",
      item_id: "reasoning_1",
      delta: "checking",
    }),
    [{
      method: "item/reasoning/textDelta",
      params: { itemId: "reasoning_1", delta: "checking" },
    }],
  );
});

Deno.test("inference snapshot recovers prompt total from llama's cumulative fraction", () => {
  const tracker = new InferenceTracker(102_400);
  // llama reports tokens processed so far plus the cumulative fraction; the
  // total follows from those two without reading the racing slot counters.
  const snapshot = tracker.snapshot({ taskId: 7, tokens: 24_000, progress: 0.25 });
  assertEquals(snapshot.phase, "prompt");
  assertEquals(snapshot.active, true);
  assertEquals(snapshot.prompt.processed, 24_000);
  assertEquals(snapshot.prompt.total, 96_000);
  assertEquals(snapshot.prompt.percent, 0.25);
});

Deno.test("inference snapshot reports billed context usage, not slot state", () => {
  const tracker = new InferenceTracker(102_400);
  tracker.observeUsage(71_118);
  const snapshot = tracker.snapshot();
  assertEquals(snapshot.phase, "idle");
  assertEquals(snapshot.context?.used, 71_118);
  assertEquals(snapshot.context?.limit, 102_400);
  assertEquals(snapshot.prompt.percent, 0);
});

Deno.test("inference snapshot always carries the fields the observer renders", () => {
  const tracker = new InferenceTracker(102_400);
  tracker.observeUsage(38_433, 30_000);
  const snapshot = tracker.snapshot();
  // The observer reads every one of these unconditionally.
  assertEquals(typeof snapshot.prompt.processed, "number");
  assertEquals(typeof snapshot.prompt.total, "number");
  assertEquals(typeof snapshot.prompt.cached, "number");
  assertEquals(typeof snapshot.prompt.percent, "number");
  assertEquals(snapshot.prompt.cached, 30_000);
});

Deno.test("inference snapshot never exceeds 100% when llama overshoots", () => {
  const tracker = new InferenceTracker(102_400);
  const snapshot = tracker.snapshot({ taskId: 1, tokens: 8_192, progress: 1.4 });
  assertEquals(snapshot.prompt.percent, 1);
});

Deno.test("untyped Responses input items are typed as message for llama.cpp", () => {
  const result = normalizeRequestBody({
    model: "qwen3.8-27b",
    input: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { type: "function_call", name: "exec", arguments: "{}" },
      { type: "message", role: "user", content: "already typed" },
    ],
  });
  const input = (result.body as Record<string, unknown>).input as Record<string, unknown>[];
  assertEquals(result.fixes, 2);
  assertEquals(input[0].type, "message");
  assertEquals(input[1].type, "message");
  assertEquals(input[2].type, "function_call");
  assertEquals(input[3].type, "message");
  assertEquals(input[0].content, "hello");
  assertEquals(result.changes.some((c) => c.includes("typed 2 untyped input item")), true);
});

Deno.test("input items that are already typed are left untouched", () => {
  const body = { model: "m", input: [{ type: "function_call_output", output: "ok" }] };
  const result = normalizeRequestBody(body);
  assertEquals(result.fixes, 0);
  assertEquals(result.body, body);
});

Deno.test("auxiliary streams are observed without being altered", async () => {
  const frames = [
    'data: {"type":"response.output_text.delta","item_id":"msg_1","delta":"Sum"}\n\n',
    'data: {"type":"response.output_text.delta","item_id":"msg_1","delta":"mary"}\n\n',
    "data: [DONE]\n\n",
  ];
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(new TextEncoder().encode(frame));
      controller.close();
    },
  });
  const seen: JsonObject[] = [];
  const out = observeStream(source, (event) => seen.push(event));
  const text = await new Response(out).text();
  // Byte-for-byte passthrough: compression/title calls must not be rewritten.
  assertEquals(text, frames.join(""));
  assertEquals(seen.length, 2);
  assertEquals(seen[0].delta, "Sum");
  assertEquals(seen[1].delta, "mary");
});

Deno.test("absent reasoning gets the deployment default, present reasoning does not", () => {
  // Auxiliary calls (compression, titles) send no reasoning block at all.
  const aux = normalizeRequestBody(
    { model: "m", input: [{ type: "message", role: "user", content: "summarize" }] },
    {},
    "none",
  );
  const auxBody = aux.body as Record<string, unknown>;
  assertEquals(auxBody.reasoning, { effort: "none" });
  // "none" must not gain chat_template_kwargs: llama.cpp maps it to
  // enable_thinking=false on its own and erases the kwarg.
  assertEquals(auxBody.chat_template_kwargs, undefined);
  assertEquals(aux.changes.some((c) => c.includes("defaulted absent reasoning")), true);

  // A real agent turn already states its effort and must be left alone.
  const turn = normalizeRequestBody(
    {
      model: "m",
      input: [{ type: "message", role: "user", content: "hi" }],
      reasoning: { effort: "low" },
    },
    {},
    "none",
  );
  const turnBody = turn.body as Record<string, unknown>;
  assertEquals((turnBody.reasoning as Record<string, unknown>).effort, "low");
  assertEquals(turn.changes.some((c) => c.includes("defaulted absent reasoning")), false);
});

Deno.test("no default configured leaves absent reasoning absent", () => {
  const body = { model: "m", input: [{ type: "message", role: "user", content: "x" }] };
  const result = normalizeRequestBody(body, {});
  assertEquals((result.body as Record<string, unknown>).reasoning, undefined);
});

const prefillProgressSse = (done: number, total: number) =>
  `event: hipfire.prefill_progress\ndata: ${
    JSON.stringify({ type: "hipfire.prefill_progress", done, total, sequence_number: 2 })
  }\n\n`;

Deno.test("renders upstream prefill progress events as the prompt evaluation trace", async () => {
  const input = new Response(
    'event: response.created\ndata: {"type":"response.created"}\n\n' +
      prefillProgressSse(0, 35288) +
      prefillProgressSse(17644, 35288) +
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"OK"}\n\n',
  ).body;
  if (!input) throw new Error("test stream unavailable");
  const output = await new Response(adaptReasoningStream(input)).text();
  assertEquals(output.includes("hipfire.prefill_progress"), false);
  const events = [...output.matchAll(/^data: (.+)$/gm)].map((match) => JSON.parse(match[1]));
  assertEquals(events.map((event) => event.type), [
    "response.created",
    "response.output_item.added",
    "response.reasoning_summary_part.added",
    "response.reasoning_summary_text.delta",
    "response.reasoning_summary_text.delta",
    "response.reasoning_summary_text.delta",
    "response.reasoning_summary_text.done",
    "response.reasoning_summary_part.done",
    "response.output_item.done",
    "response.output_text.delta",
  ]);
  assertEquals(events[3].delta, "Evaluating prompt…\n");
  assertEquals(events[4].delta, "Prompt evaluation: 0% (0 tokens)\n");
  assertEquals(events[5].delta, "Prompt evaluation: 50% (17,644 tokens)\n");
  assertEquals(events[8].item.id.startsWith("lm-tools-system-reasoning-prompt-evaluation-"), true);
});

Deno.test("drops upstream prefill progress events from observed streams", async () => {
  const input = new Response(
    prefillProgressSse(0, 100) +
      'event: response.completed\ndata: {"type":"response.completed","response":{}}\n\n',
  ).body;
  if (!input) throw new Error("test stream unavailable");
  const observed: string[] = [];
  const output = await new Response(
    observeStream(input, (event) => observed.push(String(event.type))),
  ).text();
  assertEquals(
    output,
    'event: response.completed\ndata: {"type":"response.completed","response":{}}\n\n',
  );
  assertEquals(observed, ["hipfire.prefill_progress", "response.completed"]);
});

Deno.test("reports streamed prompt progress until generation starts", () => {
  const tracker = new InferenceTracker(1000);
  tracker.observePromptProgress({ taskId: 0, tokens: 250, progress: 0.25 });
  const prompt = tracker.snapshot();
  assertEquals(prompt.phase, "prompt");
  assertEquals(prompt.prompt.processed, 250);
  assertEquals(prompt.prompt.total, 1000);
  tracker.observeGenerating();
  assertEquals(tracker.snapshot().phase, "generation");
});
