import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { join } from "jsr:@std/path@1";
import { checkVendorManifest, loadVendorManifest, vendorArtifact } from "./vendor.ts";

Deno.test("resolves declarative vendor checkout variables and artifacts", async () => {
  const root = await Deno.makeTempDir();
  try {
    const manifestPath = join(root, "vendor.json");
    await Deno.writeTextFile(
      manifestPath,
      JSON.stringify({
        version: 1,
        name: "test-build",
        checkouts: [{
          name: "engine",
          repository: "https://example.com/engine.git",
          revision: "0123456789abcdef0123456789abcdef01234567",
          path: "checkout",
          patches: ["fix.patch"],
        }],
        artifacts: [{
          name: "server",
          path: "${checkout.engine}/build/server",
          kind: "executable",
        }],
      }),
    );
    const resolved = await loadVendorManifest(manifestPath);
    assertEquals(resolved.checkouts.get("engine")?.resolvedPath, join(root, "checkout"));
    assertEquals(resolved.checkouts.get("engine")?.resolvedPatches, [join(root, "fix.patch")]);
    assertEquals(vendorArtifact(resolved, "server"), join(root, "checkout", "build", "server"));
    await assertRejects(
      () => checkVendorManifest(resolved),
      Error,
      "Missing Git checkout engine",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("resolves root relative to the manifest-owning project", async () => {
  const root = await Deno.makeTempDir();
  try {
    const vendors = join(root, "vendors");
    await Deno.mkdir(vendors);
    const manifestPath = join(vendors, "vendor.json");
    await Deno.writeTextFile(
      manifestPath,
      JSON.stringify({
        version: 1,
        name: "portable-build",
        checkouts: [{
          name: "engine",
          repository: "https://example.com/engine.git",
          revision: "0123456789abcdef0123456789abcdef01234567",
          path: "${root}/vendor/engine",
        }],
        artifacts: [{ name: "result", path: "${root}/build/result", kind: "file" }],
      }),
    );
    const resolved = await loadVendorManifest(manifestPath);
    assertEquals(vendorArtifact(resolved, "result"), join(root, "build", "result"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("rejects unknown vendor manifest variables", async () => {
  const root = await Deno.makeTempDir();
  try {
    const manifestPath = join(root, "vendor.json");
    await Deno.writeTextFile(
      manifestPath,
      JSON.stringify({
        version: 1,
        name: "bad-build",
        checkouts: [{
          name: "engine",
          repository: "https://example.com/engine.git",
          revision: "0123456789abcdef0123456789abcdef01234567",
          path: "checkout",
        }],
        artifacts: [{ name: "server", path: "${checkout.missing}/server", kind: "file" }],
      }),
    );
    await assertRejects(
      () => loadVendorManifest(manifestPath),
      Error,
      "Unknown vendor manifest variable",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
