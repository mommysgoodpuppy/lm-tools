import { assertEquals } from "jsr:@std/assert@1/equals";
import {
  apiJsonDirectory,
  buildPiProvider,
  buildTailscaleServeArgs,
  buildVscodeProvider,
  loadDeployment,
  mergeVscodeProvider,
  tailscaleApiBaseUrl,
} from "./deployment.ts";

const PROJECT_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

Deno.test("loads the declarative Qwen deployment", async () => {
  const deployment = await loadDeployment(`${PROJECT_ROOT}/deployments/qwen-vscode.json`);
  assertEquals(deployment.config.backend.kind, "llama.cpp");
  assertEquals(deployment.llama?.context, 131072);
  assertEquals(deployment.llama?.mtpDraftTokens, 2);
  assertEquals(deployment.proxy?.listen.port, 1235);
  assertEquals(deployment.tailscaleServe?.httpsPort, 443);
  assertEquals(deployment.config.resources?.gpu.mode, "exclusive");
  assertEquals(deployment.config.runtime.expectedVramMiB, 21000);
  assertEquals(deployment.config.model.capabilities.supportedReasoningLevels, [
    "none",
    "low",
    "medium",
    "xhigh",
  ]);
  assertEquals(deployment.config.model.capabilities.reasonLevelMap, undefined);
  assertEquals(
    deployment.config.resources?.gpu.mode === "exclusive"
      ? deployment.config.resources.gpu.vram.minimumRemainingMiB
      : undefined,
    2048,
  );
  assertEquals(buildTailscaleServeArgs(deployment), [
    "serve",
    "--bg",
    "--https=443",
    "http://127.0.0.1:1235",
  ]);
  assertEquals(buildTailscaleServeArgs(deployment, true), ["serve", "--https=443", "off"]);
});

Deno.test("loads the pinned DiffusionGemma Vulkan deployment", async () => {
  const deployment = await loadDeployment(`${PROJECT_ROOT}/deployments/diffusiongemma-lab.json`);
  assertEquals(deployment.config.backend.kind, "llama.cpp-diffusion");
  assertEquals(deployment.config.model.source?.size, 16806810208);
  assertEquals(deployment.llama, undefined);
  assertEquals(deployment.config.services?.[0].kind, "diffusiongemma-lab");
});

Deno.test("loads the reproducible Talkie web deployment", async () => {
  const deployment = await loadDeployment(`${PROJECT_ROOT}/deployments/talkie-web.json`);
  assertEquals(deployment.config.model.source?.size, 9861698336);
  assertEquals(
    deployment.config.model.source?.sha256,
    "c9ab17b73b12be0b701cbaece8fa7e235139fb6457e675daaef029060ce13735",
  );
  assertEquals(deployment.llama?.server, "/usr/bin/llama-server");
  assertEquals(deployment.llama?.context, 2048);
  assertEquals(deployment.proxy, undefined);
  const service = deployment.config.services?.[0];
  assertEquals(service?.kind, "process");
  assertEquals(service?.kind === "process" ? service.environment.LLAMA_EXTERNAL : undefined, "1");
});

Deno.test("generates portable API client JSON", async () => {
  const deployment = await loadDeployment(`${PROJECT_ROOT}/deployments/qwen-vscode.json`);
  const baseUrl = tailscaleApiBaseUrl("workstation.example.ts.net.", 443);
  assertEquals(baseUrl, "https://workstation.example.ts.net/v1");
  assertEquals(
    tailscaleApiBaseUrl("workstation.example.ts.net", 8443),
    "https://workstation.example.ts.net:8443/v1",
  );
  assertEquals(apiJsonDirectory(deployment), `${PROJECT_ROOT}/api-jsons/qwen3.8-27b`);
  const vscode = buildVscodeProvider(deployment, baseUrl);
  assertEquals(
    (vscode?.models as Array<Record<string, unknown>>)[0].url,
    "https://workstation.example.ts.net/v1/responses",
  );
  assertEquals(buildPiProvider(deployment, baseUrl), {
    providers: {
      "qwen-vscode": {
        baseUrl,
        api: "openai-responses",
        apiKey: "local",
        models: [{
          id: "qwen3.8-27b",
          name: "Qwen3.8 27B (local, 128K)",
          reasoning: true,
          thinkingLevelMap: {
            off: "none",
            minimal: null,
            low: "low",
            medium: "medium",
            high: null,
            xhigh: "xhigh",
            max: null,
          },
          input: ["text"],
          contextWindow: 131072,
          maxTokens: 16384,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        }],
      },
    },
  });
});

Deno.test("generates and merges the VS Code provider", async () => {
  const deployment = await loadDeployment(`${PROJECT_ROOT}/deployments/qwen-vscode.json`);
  const provider = buildVscodeProvider(deployment);
  if (!provider) throw new Error("expected VS Code provider");
  const merged = mergeVscodeProvider([
    { name: "Other", vendor: "elsewhere" },
    { name: "Local Qwen", vendor: "customendpoint", stale: true },
  ], provider);
  assertEquals(merged.length, 2);
  assertEquals(merged[1], provider);
  assertEquals(
    (provider.models as Array<Record<string, unknown>>)[0].url,
    "http://127.0.0.1:1235/v1/responses",
  );
});

Deno.test("rejects undeclared deployment fields", async () => {
  const original = JSON.parse(
    await Deno.readTextFile(`${PROJECT_ROOT}/deployments/qwen-vscode.json`),
  );
  original.backend.context = 131072;
  const directory = await Deno.makeTempDir({ prefix: "lm-tools-deployment-test-" });
  try {
    const path = `${directory}/invalid.json`;
    await Deno.writeTextFile(path, JSON.stringify(original));
    let message = "";
    try {
      await loadDeployment(path);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assertEquals(message.includes("must NOT have additional properties"), true);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
