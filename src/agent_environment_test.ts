import { assertEquals } from "jsr:@std/assert@1/equals";
import { assertThrows } from "jsr:@std/assert@1/throws";
import {
  buildSeedArchive,
  isSupportedHostUnit,
  npmRegistryIntegrity,
  parseStrictDotenv,
  tailscaleServeNeedsApply,
} from "./agent_environment.ts";

Deno.test("host service units include socket activation", () => {
  assertEquals(isSupportedHostUnit("worker.service"), true);
  assertEquals(isSupportedHostUnit("worker.socket"), true);
  assertEquals(isSupportedHostUnit("worker.target"), true);
  assertEquals(isSupportedHostUnit("worker.timer"), false);
});

Deno.test("normalizes scalar and npm 12 one-element integrity responses", () => {
  const integrity = "sha512-pinned";
  assertEquals(npmRegistryIntegrity(integrity), integrity);
  assertEquals(npmRegistryIntegrity([integrity]), integrity);
  assertEquals(npmRegistryIntegrity([integrity, integrity]), undefined);
});

Deno.test("strict dotenv parsing rejects shell syntax and undeclared keys", () => {
  assertEquals(
    parseStrictDotenv("# local only\nSERVICE_TOKEN=abc\nOWNER_ID='def'\n", [
      "SERVICE_TOKEN",
      "OWNER_ID",
    ]),
    { SERVICE_TOKEN: "abc", OWNER_ID: "def" },
  );
  assertThrows(() => parseStrictDotenv("TOKEN=$(id)\n", ["TOKEN"]));
  assertThrows(() => parseStrictDotenv("TOKEN=one\nTOKEN=two\n", ["TOKEN"]));
  assertThrows(() => parseStrictDotenv("TOKEN=one\nEXTRA=two\n", ["TOKEN"]));
});

Deno.test("Git-aware seed selection honors ignore rules and hard-denies dotenv", async () => {
  const parent = await Deno.makeTempDir({ prefix: "lm-tools-seed-" });
  const source = `${parent}/checkout`;
  await Deno.mkdir(source);
  const git = async (args: string[]) => {
    const output = await new Deno.Command("/usr/bin/git", {
      args: ["-C", source, ...args],
      stdout: "null",
      stderr: "piped",
    }).output();
    if (!output.success) throw new Error(new TextDecoder().decode(output.stderr));
  };
  try {
    await git(["init", "--quiet"]);
    await Deno.writeTextFile(`${source}/.gitignore`, "ignored.txt\n.env\n");
    await Deno.writeTextFile(`${source}/tracked.txt`, "before\n");
    await Deno.writeTextFile(`${source}/.env`, "SECRET=tracked-but-denied\n");
    await git(["add", ".gitignore", "tracked.txt"]);
    await git(["add", "--force", ".env"]);
    await Deno.writeTextFile(`${source}/tracked.txt`, "dirty\n");
    await Deno.writeTextFile(`${source}/untracked.txt`, "new\n");
    await Deno.writeTextFile(`${source}/ignored.txt`, "ignored\n");
    const plan = buildSeedArchive({
      source,
      target: `/guest/${source.split("/").at(-1)}`,
      exclude: [],
      policy: "create",
    });
    assertEquals(plan.mode, "git");
    const selected = new TextDecoder().decode(plan.stdin).split("\0").filter(Boolean);
    assertEquals(selected.includes("checkout/tracked.txt"), true);
    assertEquals(selected.includes("checkout/untracked.txt"), true);
    assertEquals(selected.some((path) => path.endsWith("/.env")), false);
    assertEquals(selected.includes("checkout/ignored.txt"), false);
    assertEquals(plan.command.args.includes("--no-recursion"), true);
    const archive = new Deno.Command(plan.command.executable, {
      args: plan.command.args,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const writer = archive.stdin.getWriter();
    await writer.write(plan.stdin);
    await writer.close();
    const archiveOutput = await archive.output();
    assertEquals(archiveOutput.success, true);
    const listing = new Deno.Command("/usr/bin/tar", {
      args: ["-tf", "-"],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const listingWriter = listing.stdin.getWriter();
    await listingWriter.write(archiveOutput.stdout);
    await listingWriter.close();
    const listingOutput = await listing.output();
    assertEquals(listingOutput.success, true);
    const archivedPaths = new TextDecoder().decode(listingOutput.stdout).split("\n");
    assertEquals(archivedPaths.includes("checkout/tracked.txt"), true);
    assertEquals(archivedPaths.includes("checkout/untracked.txt"), true);
    assertEquals(archivedPaths.some((path) => path.endsWith("/.env")), false);
  } finally {
    await Deno.remove(parent, { recursive: true });
  }
});

Deno.test("Tailscale exposure preserves its route and rejects another owner", () => {
  const desired = "http://127.0.0.1:18789";
  assertEquals(
    tailscaleServeNeedsApply(
      {
        TCP: { "8443": { HTTPS: true } },
        Web: {
          "host.example.ts.net:8443": { Handlers: { "/": { Proxy: desired } } },
        },
      },
      "host.example.ts.net.",
      8443,
      desired,
    ),
    false,
  );
  assertThrows(() =>
    tailscaleServeNeedsApply(
      {
        TCP: { "8443": { HTTPS: true } },
        Web: {
          "host.example.ts.net:8443": {
            Handlers: { "/": { Proxy: "http://127.0.0.1:9999" } },
          },
        },
      },
      "host.example.ts.net",
      8443,
      desired,
    )
  );
});
