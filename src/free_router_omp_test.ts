import { assertEquals, assertStringIncludes, assertThrows } from "jsr:@std/assert@1";
import {
  buildOmpFreeRouterModelsYml,
  buildOmpFreeRouterProvider,
  freeRouterPublicModelIdentity,
} from "./free_router_omp.ts";
import type { FreeRouterServiceConfig } from "./free_router_server.ts";

const CONFIG: FreeRouterServiceConfig = {
  version: 1,
  listen: { host: "10.0.0.1", port: 1260 },
  omp: { baseUrl: "http://127.0.0.1:4000", bearerTokenFile: "secret-token" },
  models: [{
    id: "free-auto",
    contextLength: 131072,
    maxOutputTokens: 32768,
    offers: [{
      id: "free-route",
      adapter: "omp",
      provider: "example",
      model: "large-model",
      accessClass: "free",
      pricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
      priority: 10,
    }],
  }, {
    id: "free-worker",
    contextLength: 65536,
    maxOutputTokens: 8192,
    offers: [{
      id: "worker-route",
      adapter: "omp",
      provider: "worker-provider",
      model: "worker-model",
      accessClass: "free",
      pricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
    }],
  }],
};

Deno.test("OMP free-router profile exposes one public lane without upstream credentials", () => {
  const profile = buildOmpFreeRouterProvider(CONFIG, {
    baseUrl: "http://10.0.0.1:1260/v1/",
    publicModel: "free-auto",
  }) as {
    providers: Record<string, Record<string, unknown>>;
  };
  const provider = profile.providers["lm-free-router"];
  assertEquals(provider.baseUrl, "http://10.0.0.1:1260/v1");
  assertEquals(provider.api, "openai-completions");
  assertEquals(provider.auth, "none");
  const serialized = JSON.stringify(profile);
  assertEquals(serialized.includes("secret-token"), false);
  assertEquals(serialized.includes("large-model"), false);
  assertStringIncludes(
    buildOmpFreeRouterModelsYml(CONFIG, {
      baseUrl: "http://10.0.0.1:1260/v1",
      publicModel: "free-auto",
    }),
    "free-auto",
  );
});

Deno.test("OMP free-router profile can expose primary and worker lanes together", () => {
  const serialized = buildOmpFreeRouterModelsYml(CONFIG, {
    baseUrl: "http://10.0.0.1:1260/v1",
    publicModels: ["free-auto", "free-worker"],
  });
  assertStringIncludes(serialized, "id: free-auto");
  assertStringIncludes(serialized, "id: free-worker");
  assertEquals(serialized.includes("large-model"), false);
  assertEquals(serialized.includes("worker-model"), false);
});

Deno.test("free-router public identity is attributable without authentication state", () => {
  const identity = freeRouterPublicModelIdentity(CONFIG, "free-auto");
  assertEquals(identity.offers[0].model, "large-model");
  assertEquals(JSON.stringify(identity).includes("secret-token"), false);
});

Deno.test("OMP free-router profile fails closed on incomplete or unknown lanes", () => {
  assertThrows(
    () =>
      buildOmpFreeRouterProvider(CONFIG, {
        baseUrl: "not-a-url",
        publicModel: "free-auto",
      }),
    Error,
    "base URL",
  );
  assertThrows(
    () =>
      buildOmpFreeRouterProvider(CONFIG, {
        baseUrl: "http://router/v1",
        publicModel: "missing",
      }),
    Error,
    "Unknown free-router public model",
  );
  assertThrows(
    () =>
      buildOmpFreeRouterProvider(CONFIG, {
        baseUrl: "http://router/v1",
        publicModels: ["free-auto", "free-auto"],
      }),
    Error,
    "must be unique",
  );
});
