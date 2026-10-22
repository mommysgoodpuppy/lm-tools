import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { join } from "jsr:@std/path@1";
import {
  checkVendorManifest,
  loadVendorManifest,
  vendorArtifact,
  vendorCommand,
} from "./vendor.ts";

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

async function git(cwd: string, ...args: string[]): Promise<string> {
  const output = await new Deno.Command("git", {
    args: ["-C", cwd, "-c", "user.name=test", "-c", "user.email=test@example.com", ...args],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) throw new Error(new TextDecoder().decode(output.stderr));
  return new TextDecoder().decode(output.stdout).trim();
}

Deno.test("applies and verifies a patch series whose patches touch the same lines", async () => {
  const root = await Deno.makeTempDir();
  try {
    const checkout = join(root, "engine");
    await Deno.mkdir(checkout);
    await git(checkout, "init", "-q");
    await git(checkout, "remote", "add", "origin", "https://example.com/engine.git");
    await Deno.writeTextFile(join(checkout, ".gitignore"), "build/\n");
    await Deno.writeTextFile(join(checkout, "main.txt"), "one\ntwo\n");
    await git(checkout, "add", "-A");
    await git(checkout, "commit", "-qm", "base");
    const revision = await git(checkout, "rev-parse", "HEAD");
    await Deno.writeTextFile(join(checkout, "main.txt"), "one\ntwo\nthree\n");
    await Deno.writeTextFile(join(root, "0001.patch"), `${await git(checkout, "diff")}\n`);
    await git(checkout, "commit", "-qam", "first");
    await Deno.writeTextFile(join(checkout, "main.txt"), "one\ntwo\nthree, revised\n");
    await Deno.writeTextFile(join(root, "0002.patch"), `${await git(checkout, "diff")}\n`);
    await git(checkout, "checkout", "-q", "--", ".");
    await git(checkout, "checkout", "-q", "--detach", revision);
    await Deno.mkdir(join(checkout, "build"));
    await Deno.writeTextFile(join(checkout, "build", "server"), "built\n");

    const manifestPath = join(root, "vendor.json");
    await Deno.writeTextFile(
      manifestPath,
      JSON.stringify({
        version: 1,
        name: "series-build",
        checkouts: [{
          name: "engine",
          repository: "https://example.com/engine.git",
          revision,
          path: "engine",
          patches: ["0001.patch", "0002.patch"],
        }],
        artifacts: [{ name: "server", path: "${checkout.engine}/build/server", kind: "file" }],
      }),
    );
    const resolved = await loadVendorManifest(manifestPath);
    await assertRejects(() => checkVendorManifest(resolved), Error, "Patches are not applied");

    await vendorCommand([manifestPath]);
    assertEquals(await Deno.readTextFile(join(checkout, "main.txt")), "one\ntwo\nthree, revised\n");
    await checkVendorManifest(resolved);
    await vendorCommand([manifestPath]);

    await Deno.writeTextFile(join(checkout, "stray.txt"), "local\n");
    await assertRejects(
      () => checkVendorManifest(resolved),
      Error,
      "Unexpected local changes in engine (relative to its patch series): stray.txt",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
