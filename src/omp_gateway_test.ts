import { assertEquals } from "jsr:@std/assert@1/equals";
import { assertRejects } from "jsr:@std/assert@1/rejects";
import { FreeAccessError, FreeRouteOffer } from "./free_router.ts";
import { decodeServerSentEvents, OmpGatewayAdapter } from "./omp_gateway.ts";

const encoder = new TextEncoder();
const offer: FreeRouteOffer = {
  id: "omp:groq:account-pool:llama",
  adapter: "omp",
  provider: "groq",
  model: "llama-test",
  accessClass: "free",
  pricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
};

function sseResponse(parts: string[]): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const part of parts) controller.enqueue(encoder.encode(part));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

Deno.test("OMP adapter qualifies models and commits on generated output", async () => {
  let received: Record<string, unknown> | undefined;
  let authorization: string | null = null;
  let app: string | null = null;
  const adapter = new OmpGatewayAdapter({
    baseUrl: "http://127.0.0.1:4000/",
    bearerToken: "gateway-secret",
    fetch: (_input, init) => {
      received = JSON.parse(String(init?.body));
      authorization = new Headers(init?.headers).get("authorization");
      app = new Headers(init?.headers).get("x-omp-app");
      return Promise.resolve(sseResponse([
        'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
        "data: [DONE]\n\n",
      ]));
    },
  });

  const events = [];
  for await (
    const event of adapter.stream(offer, { messages: [{ role: "user", content: "hi" }] })
  ) {
    events.push(event);
  }

  assertEquals(received?.model, "groq/llama-test");
  assertEquals(received?.stream, true);
  assertEquals(received?.stream_options, { include_usage: true });
  assertEquals(authorization, "Bearer gateway-secret");
  assertEquals(app, "lm-tools");
  assertEquals(events.map((event) => event.commitsOutput), [false, true, false]);
});

Deno.test("OMP adapter maps gateway failures without exposing its bearer", async () => {
  const adapter = new OmpGatewayAdapter({
    baseUrl: "http://127.0.0.1:4000",
    bearerToken: "gateway-secret",
    fetch: () =>
      Promise.resolve(
        new Response(
          JSON.stringify({ error: { message: "quota exhausted for gateway-secret" } }),
          { status: 429, headers: { "retry-after": "2" } },
        ),
      ),
  });

  const consume = async () => {
    for await (const _event of adapter.stream(offer, { messages: [] })) {
      // Consume to surface the response error.
    }
  };
  const error = await assertRejects(consume, FreeAccessError, "[redacted]");
  assertEquals(error.failure.kind, "quota");
  assertEquals(error.failure.retryAfterMs, 2_000);
});

Deno.test("SSE decoder handles split CRLF and multiline data", async () => {
  const response = sseResponse(["data: one\r", "\ndata: two\r\n\r", "\ndata: [DONE]\n\n"]);
  const events = [];
  for await (const event of decodeServerSentEvents(response.body!)) events.push(event);
  assertEquals(events, ["one\ntwo", "[DONE]"]);
});

Deno.test("OMP model discovery preserves provider-qualified ids", async () => {
  const adapter = new OmpGatewayAdapter({
    baseUrl: "http://127.0.0.1:4000",
    fetch: () =>
      Promise.resolve(Response.json({
        object: "list",
        data: [{ id: "google/gemini-test", owned_by: "google", context_length: 123 }],
      })),
  });
  assertEquals(await adapter.listModels(), [{
    id: "google/gemini-test",
    owned_by: "google",
    context_length: 123,
  }]);
});
