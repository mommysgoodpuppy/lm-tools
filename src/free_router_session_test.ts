import { assertEquals, assertExists, assertRejects } from "jsr:@std/assert@1";
import { join } from "jsr:@std/path@1";
import { startFreeRouterSession } from "./free_router_session.ts";
import type { FreeRouterModelConfig } from "./free_router_server.ts";

function freePort(): number {
  return 20000 + Math.floor(Math.random() * 30000);
}

const NVIDIA_ONLY_MODEL: FreeRouterModelConfig = {
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

Deno.test("campaign free-router session serves only its declared lanes and leaves no credentials on disk", async () => {
  const directory = await Deno.makeTempDir();
  const tokenPath = join(directory, "gateway-token");
  await Deno.writeTextFile(tokenPath, "secret-gateway-token");
  const port = freePort();

  {
    await using session = await startFreeRouterSession({
      listen: { host: "127.0.0.1", port },
      models: [NVIDIA_ONLY_MODEL],
      ompGateway: { baseUrl: "http://127.0.0.1:4000", bearerTokenFile: tokenPath },
      artifactsDirectory: join(directory, "router"),
    });

    assertEquals(session.publicModels.length, 1);
    assertEquals(session.publicModels[0].id, "free-auto");
    assertEquals(
      session.baseUrl,
      `http://127.0.0.1:${port}/v1`,
    );

    const health = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json() as {
      eligibleModels: string[];
    };
    assertEquals(health.eligibleModels, ["free-auto"]);

    const models = await (
      await fetch(`http://127.0.0.1:${port}/v1/models`)
    ).json() as { data: Array<{ id: string }> };
    assertEquals(models.data.map((model) => model.id), ["free-auto"]);

    const unknown = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "fallback-model", messages: [] }),
    });
    assertEquals(unknown.status, 404);

    const materialized = await Deno.readTextFile(session.configPath);
    assertEquals(materialized.includes("secret-gateway-token"), false);
    assertEquals(materialized.includes("bearerTokenFile"), false);
    const receipt = JSON.parse(await Deno.readTextFile(session.receiptPath)) as {
      configSha256: string;
      readyAt?: string;
      shutdown?: unknown;
    };
    assertExists(receipt.readyAt);
    assertEquals(receipt.shutdown, undefined);
    assertEquals(receipt.configSha256, session.receipt().configSha256);
    assertEquals(
      JSON.stringify(receipt).includes("secret-gateway-token"),
      false,
    );

    const shutdown = await session.shutdown("explicit");
    assertExists(shutdown.shutdown);
    assertEquals(shutdown.shutdown.reason, "explicit");
  }

  // Explicit shutdown releases the port lease and closes the listener.
  const listener = await Deno.listen({ hostname: "127.0.0.1", port });
  listener.close();
  await Deno.remove(directory, { recursive: true });
});

Deno.test("campaign free-router session fails closed when its lane is not eligible and cleans artifacts", async () => {
  const directory = await Deno.makeTempDir();
  const port = freePort();
  await assertRejects(
    () =>
      startFreeRouterSession({
        listen: { host: "127.0.0.1", port },
        // A paid offer under the default policy never becomes eligible, so the
        // router must refuse to report ready rather than serve a fallback.
        models: [{
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
        }],
        ompGateway: { baseUrl: "http://127.0.0.1:4000" },
        artifactsDirectory: join(directory, "router"),
        readinessTimeoutMs: 300,
      }),
    Error,
    "did not become ready",
  );
  const remaining = [];
  for await (const entry of Deno.readDir(join(directory, "router"))) remaining.push(entry.name);
  assertEquals(remaining, []);
  await Deno.remove(directory, { recursive: true });
});

Deno.test("a live campaign router holds its port against a second session", async () => {
  const directory = await Deno.makeTempDir();
  const port = freePort();
  const first = await startFreeRouterSession({
    listen: { host: "127.0.0.1", port },
    models: [NVIDIA_ONLY_MODEL],
    ompGateway: { baseUrl: "http://127.0.0.1:4000" },
    artifactsDirectory: join(directory, "router-a"),
  });
  await assertRejects(
    () =>
      startFreeRouterSession({
        listen: { host: "127.0.0.1", port },
        models: [NVIDIA_ONLY_MODEL],
        ompGateway: { baseUrl: "http://127.0.0.1:4000" },
        artifactsDirectory: join(directory, "router-b"),
      }),
    Error,
    "already leased",
  );
  await first.shutdown();

  // After shutdown the port is free for a later attempt.
  const second = await startFreeRouterSession({
    listen: { host: "127.0.0.1", port },
    models: [NVIDIA_ONLY_MODEL],
    ompGateway: { baseUrl: "http://127.0.0.1:4000" },
    artifactsDirectory: join(directory, "router-b"),
  });
  const receipt = second.receipt();
  assertExists(receipt.readyAt);
  await second.shutdown();
  await Deno.remove(directory, { recursive: true });
});

Deno.test("external cancellation produces a cancelled shutdown receipt with no orphan router", async () => {
  const directory = await Deno.makeTempDir();
  const port = freePort();
  const controller = new AbortController();
  const session = await startFreeRouterSession({
    listen: { host: "127.0.0.1", port },
    models: [NVIDIA_ONLY_MODEL],
    ompGateway: { baseUrl: "http://127.0.0.1:4000" },
    artifactsDirectory: join(directory, "router"),
    signal: controller.signal,
  });
  controller.abort();
  const receipt = await session.shutdown();
  assertEquals(receipt.shutdown?.reason, "cancelled");
  const persisted = JSON.parse(await Deno.readTextFile(session.receiptPath)) as {
    shutdown?: { reason: string };
  };
  assertEquals(persisted.shutdown?.reason, "cancelled");
  await Deno.remove(directory, { recursive: true });
});
