import { assertEquals } from "jsr:@std/assert@1/equals";
import { adaptReasoningEvent, adaptReasoningStream, normalizeRequestBody } from "./proxy.ts";

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
      fixes: 2,
      changes: ["removed 2 system reasoning trace artifact(s)"],
      body: {
        input: [
          { type: "reasoning", id: "rs_model", text: "Actual model reasoning" },
          { role: "user", content: "Keep this" },
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
