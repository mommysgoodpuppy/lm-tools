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
  assertEquals(output.includes("response.reasoning_summary_part.done"), true);
});
