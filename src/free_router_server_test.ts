import { assertEquals } from "jsr:@std/assert@1/equals";
import { assertRejects } from "jsr:@std/assert@1/rejects";
import {
  createFreeRouterHandler,
  FreeRouterObserver,
  FreeRouterServiceConfig,
  loadFreeRouterConfig,
} from "./free_router_server.ts";
import { OmpGatewayAdapter } from "./omp_gateway.ts";

const encoder = new TextEncoder();

function config(): FreeRouterServiceConfig {
  return {
    version: 1,
    listen: { host: "127.0.0.1", port: 1260 },
    omp: { baseUrl: "http://127.0.0.1:4000" },
    models: [{
      id: "free-auto",
      contextLength: 131_072,
      maxOutputTokens: 32_768,
      offers: [
        {
          id: "first",
          adapter: "omp",
          provider: "groq",
          model: "model-a",
          accessClass: "free",
          pricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
          priority: 0,
        },
        {
          id: "second",
          adapter: "omp",
          provider: "google",
          model: "model-b",
          accessClass: "free",
          pricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
          priority: 1,
        },
      ],
    }],
  };
}

function sse(parts: unknown[]): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const part of parts) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(part)}\n\n`));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

Deno.test("free-router permits one route identity in multiple public model lanes", async () => {
  const value = config();
  value.models.push({
    id: "free-worker",
    offers: [{ ...value.models[0].offers[0], priority: 50 }],
  });
  const directory = await Deno.makeTempDir();
  const path = `${directory}/router.json`;
  try {
    await Deno.writeTextFile(path, JSON.stringify(value));
    const loaded = await loadFreeRouterConfig(path);
    assertEquals(loaded.models.map((model) => model.id), ["free-auto", "free-worker"]);

    value.models[1].offers[0] = { ...value.models[1].offers[0], model: "different-model" };
    await Deno.writeTextFile(path, JSON.stringify(value));
    await assertRejects(
      () => loadFreeRouterConfig(path),
      Error,
      "Conflicting route offer identity: first",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("free-router fails over before commit and rewrites the public model id", async () => {
  const attempted: string[] = [];
  const adapter = new OmpGatewayAdapter({
    baseUrl: "http://127.0.0.1:4000",
    fetch: (_input, init) => {
      const body = JSON.parse(String(init?.body));
      attempted.push(body.model);
      if (body.model === "groq/model-a") {
        return Promise.resolve(Response.json({ error: { message: "limited" } }, { status: 429 }));
      }
      return Promise.resolve(sse([
        {
          id: "upstream",
          model: "google/model-b",
          choices: [{ index: 0, delta: { role: "assistant" } }],
        },
        {
          id: "upstream",
          model: "google/model-b",
          choices: [{ index: 0, delta: { content: "hello" } }],
        },
      ]));
    },
  });
  const handler = createFreeRouterHandler(config(), adapter, () => {});
  const response = await handler(
    new Request("http://router/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "free-auto",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    }),
  );
  const output = await response.text();
  assertEquals(response.status, 200);
  assertEquals(attempted, ["groq/model-a", "google/model-b"]);
  assertEquals(output.includes('"model":"free-auto"'), true);
  assertEquals(output.endsWith("data: [DONE]\n\n"), true);
});

Deno.test("free-router aggregates an OMP stream for non-streaming clients", async () => {
  const adapter = new OmpGatewayAdapter({
    baseUrl: "http://127.0.0.1:4000",
    fetch: () =>
      Promise.resolve(sse([
        { id: "upstream", created: 123, choices: [{ index: 0, delta: { role: "assistant" } }] },
        { choices: [{ index: 0, delta: { content: "hel" } }] },
        {
          choices: [{ index: 0, delta: { content: "lo" }, finish_reason: "stop" }],
          usage: { total_tokens: 3 },
        },
      ])),
  });
  const handler = createFreeRouterHandler(config(), adapter, () => {});
  const response = await handler(
    new Request("http://router/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "free-auto", messages: [], stream: false }),
    }),
  );
  const body = await response.json();
  assertEquals(response.status, 200);
  assertEquals(body.model, "free-auto");
  assertEquals(body.choices[0].message.content, "hello");
  assertEquals(body.usage.total_tokens, 3);
});

Deno.test("free-router merges streaming tool-call deltas for non-streaming clients", async () => {
  const adapter = new OmpGatewayAdapter({
    baseUrl: "http://127.0.0.1:4000",
    fetch: () =>
      Promise.resolve(sse([
        {
          choices: [{
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [{
                index: 0,
                id: "call-ready",
                type: "function",
                function: { name: "report_ready", arguments: "" },
              }],
            },
          }],
        },
        {
          choices: [{
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: '{"status":' } }] },
          }],
        },
        {
          choices: [{
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: '"ready"}' } }] },
            finish_reason: "tool_calls",
          }],
        },
      ])),
  });
  const handler = createFreeRouterHandler(config(), adapter, () => {});
  const response = await handler(
    new Request("http://router/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "free-auto", messages: [], stream: false }),
    }),
  );
  const body = await response.json();
  assertEquals(body.choices[0].finish_reason, "tool_calls");
  assertEquals(body.choices[0].message.tool_calls, [{
    id: "call-ready",
    type: "function",
    function: { name: "report_ready", arguments: '{"status":"ready"}' },
  }]);
});

Deno.test("free-router model discovery fails closed on non-zero offers", async () => {
  const value = config();
  value.models[0].offers[0].pricing = { inputUsdPerMillion: 0, outputUsdPerMillion: 0.1 };
  value.models[0].offers.splice(1);
  const adapter = new OmpGatewayAdapter({
    baseUrl: "http://127.0.0.1:4000",
    fetch: () => Promise.reject(new Error("should not fetch")),
  });
  const response = await createFreeRouterHandler(value, adapter, () => {})(
    new Request("http://router/v1/models"),
  );
  assertEquals(await response.json(), { object: "list", data: [] });
});

Deno.test("free-router publishes configured public model limits", async () => {
  const adapter = new OmpGatewayAdapter({
    baseUrl: "http://127.0.0.1:4000",
    fetch: () => Promise.reject(new Error("should not fetch")),
  });
  const response = await createFreeRouterHandler(config(), adapter, () => {})(
    new Request("http://router/v1/models"),
  );
  assertEquals(await response.json(), {
    object: "list",
    data: [{
      id: "free-auto",
      object: "model",
      owned_by: "lm-tools",
      context_length: 131_072,
      max_output_tokens: 32_768,
    }],
  });
});

Deno.test("free-router status exposes the concrete last route without credentials", async () => {
  const adapter = new OmpGatewayAdapter({
    baseUrl: "http://127.0.0.1:4000",
    fetch: () =>
      Promise.resolve(sse([
        { choices: [{ index: 0, delta: { content: "ready" } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ])),
  });
  const handler = createFreeRouterHandler(config(), adapter, () => {});
  const completion = await handler(
    new Request("http://router/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "free-auto", messages: [], stream: false }),
    }),
  );
  await completion.body?.cancel();
  const response = await handler(new Request("http://router/v1/free-router/status"));
  const body = await response.json();
  assertEquals(response.status, 200);
  assertEquals(body.status, "idle");
  assertEquals(body.active, []);
  assertEquals(body.lastCompleted.provider, "groq");
  assertEquals(body.lastCompleted.model, "model-a");
  assertEquals(body.lastCompleted.publicModel, "free-auto");
  assertEquals(body.routes.map((route: { state: string }) => route.state), ["ready", "ready"]);
  assertEquals(JSON.stringify(body).includes("api_key"), false);
});

Deno.test("free-router observer retains the complete model request and response audit", async () => {
  const adapter = new OmpGatewayAdapter({
    baseUrl: "http://127.0.0.1:4000",
    fetch: () =>
      Promise.resolve(sse([
        { choices: [{ index: 0, delta: { reasoning_content: "considering" } }] },
        { choices: [{ index: 0, delta: { content: "answer" } }] },
        {
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
        },
      ])),
  });
  const handler = createFreeRouterHandler(config(), adapter, () => {});
  const completion = await handler(
    new Request("http://router/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "free-auto",
        messages: [
          { role: "system", content: "never retain this system prompt" },
          { role: "user", content: "show this user message" },
          { role: "assistant", tool_calls: [{ id: "call-1", function: { name: "inspect" } }] },
          { role: "tool", tool_call_id: "call-1", content: "tool result" },
        ],
        tools: [{ type: "function", function: { name: "inspect" } }],
        stream: false,
      }),
    }),
  );
  await completion.json();

  const response = await handler(new Request("http://router/v1/free-router/observer"));
  const body = await response.json();
  assertEquals(response.status, 200);
  assertEquals(body.observer.kind, "free-router");
  assertEquals(body.requests[0].reasoning, "considering");
  assertEquals(body.requests[0].content, "answer");
  assertEquals(body.requests[0].userMessage, "show this user message");
  assertEquals(body.requests[0].requestBody.messages[0].role, "system");
  assertEquals(body.requests[0].requestBody.messages[3].content, "tool result");
  assertEquals(body.requests[0].requestBody.tools[0].function.name, "inspect");
  assertEquals(body.requests[0].capture.requestBody, "complete");
  assertEquals(body.requests[0].capture.responseChunks, "complete");
  assertEquals(body.requests[0].responseChunks.length, 3);
  assertEquals(body.requests[0].status, "completed");
  assertEquals(
    body.requests[0].routes.some((route: { type: string }) => route.type === "committed"),
    true,
  );
  assertEquals(body.campaign.usage.totalTokens, 9);
  assertEquals(JSON.stringify(body).includes("never retain this system prompt"), true);
  assertEquals(body.retention.maximumRequests, 2_000);
  assertEquals(body.retention.excluded.length > 0, true);

  const summaryResponse = await handler(
    new Request("http://router/v1/free-router/observer?detail=summary"),
  );
  const summary = await summaryResponse.json();
  assertEquals(summary.requests[0].requestBody, undefined);
  assertEquals(summary.requests[0].responseChunks, undefined);
  assertEquals(summary.requests[0].reasoning, undefined);
  assertEquals(summary.requests[0].content, undefined);

  const detailResponse = await handler(
    new Request(`http://router/v1/free-router/observer/request?id=${body.requests[0].id}`),
  );
  const detail = await detailResponse.json();
  assertEquals(detail.requestBody.messages[0].content, "never retain this system prompt");
  assertEquals(detail.responseChunks.length, 3);

  const conversationResponse = await handler(
    new Request(
      `http://router/v1/free-router/observer/conversation?id=${body.requests[0].conversationId}`,
    ),
  );
  const conversation = await conversationResponse.json();
  assertEquals(conversation.requests[0].reasoning, "considering");
  assertEquals(conversation.requests[0].content, "answer");
  assertEquals(conversation.requests[0].requestBody, undefined);
  assertEquals(conversation.requests[0].audit.messageCount, 4);
  assertEquals(conversation.requests[0].audit.responseChunkCount, 3);
});

Deno.test("free-router observer groups requests by hashed conversation metadata", async () => {
  const adapter = new OmpGatewayAdapter({
    baseUrl: "http://127.0.0.1:4000",
    fetch: () => Promise.resolve(sse([{ choices: [{ index: 0, delta: { content: "ok" } }] }])),
  });
  const handler = createFreeRouterHandler(config(), adapter, () => {});
  for (
    const [conversationId, turnId] of [
      ["private-session-a", "private-turn-a"],
      ["private-session-a", "private-turn-a"],
      ["private-session-b", "private-turn-b"],
    ]
  ) {
    const response = await handler(
      new Request("http://router/v1/chat/completions", {
        method: "POST",
        headers: {
          "x-lm-tools-conversation-id": conversationId,
          "x-lm-tools-conversation-source": "Discord DM",
          "x-lm-tools-turn-id": turnId,
        },
        body: JSON.stringify({ model: "free-auto", messages: [], stream: false }),
      }),
    );
    await response.json();
  }

  const response = await handler(new Request("http://router/v1/free-router/observer"));
  const body = await response.json();
  const ids = body.requests.map((request: { conversationId: string }) => request.conversationId);
  assertEquals(ids[0], ids[1]);
  assertEquals(ids[0] === ids[2], false);
  assertEquals(ids.every((id: string) => /^chat-[a-f0-9]{16}$/.test(id)), true);
  assertEquals(body.requests[0].conversationSource, "discord-dm");
  assertEquals(body.requests[0].turnId, body.requests[1].turnId);
  assertEquals(body.requests[0].turnId === body.requests[2].turnId, false);
  assertEquals(JSON.stringify(body).includes("private-session-a"), false);
  assertEquals(JSON.stringify(body).includes("private-turn-a"), false);
});

Deno.test("free-router observer replays its durable audit journal", async () => {
  const directory = await Deno.makeTempDir({ prefix: "lm-tools-free-router-audit-" });
  const journalPath = `${directory}/audit.jsonl`;
  try {
    const observer = new FreeRouterObserver({ journalPath });
    const requestId = observer.begin(
      "free-auto",
      { id: "chat-persisted", source: "test" },
      "turn-persisted",
      {
        model: "free-auto",
        messages: [{ role: "system", content: "durable system prompt" }],
        tools: [{ type: "function", function: { name: "durable_tool" } }],
      },
    );
    observer.observeChunk(requestId, {
      choices: [{ delta: { reasoning_content: "durable thought", content: "durable answer" } }],
    });
    observer.fail(requestId, new Error("persisted failure"));
    await observer.flush();

    const restored = new FreeRouterObserver({ journalPath });
    const snapshot = restored.snapshot({});
    const requests = snapshot.requests as Array<Record<string, unknown>>;
    assertEquals(requests.length, 1);
    assertEquals((requests[0].requestBody as { messages: unknown[] }).messages.length, 1);
    assertEquals(requests[0].reasoning, "durable thought");
    assertEquals(requests[0].content, "durable answer");
    assertEquals(requests[0].error, "persisted failure");
    assertEquals((snapshot.retention as { journal: { enabled: boolean } }).journal.enabled, true);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
