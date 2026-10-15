import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1";
import { join } from "jsr:@std/path@1";
import {
  loadOmpRuntimePin,
  managedOmpRuntimeLayout,
  resolveManagedOmpExecutable,
} from "./omp_runtime.ts";

const PIN = `repository=https://example.invalid/omp.git
tag=v1.2.3
commit=0123456789abcdef
package_version=1.2.3
runtime=bun
bun_version=1.4.0
`;

Deno.test("managed OMP layout is revision scoped", async () => {
  const directory = await Deno.makeTempDir();
  const versionPath = join(directory, "omp.version");
  await Deno.writeTextFile(versionPath, PIN);
  const pin = await loadOmpRuntimePin(versionPath);
  assertEquals(pin.commit, "0123456789abcdef");
  const layout = await managedOmpRuntimeLayout({ dataHome: directory, versionPath });
  assertEquals(
    layout.executable,
    join(directory, "lm-tools", "runtimes", "omp", pin.commit, "bin", "omp"),
  );
  await Deno.remove(directory, { recursive: true });
});

Deno.test("managed OMP resolution requires a matching receipt and executable", async () => {
  const directory = await Deno.makeTempDir();
  const versionPath = join(directory, "omp.version");
  await Deno.writeTextFile(versionPath, PIN);
  const layout = await managedOmpRuntimeLayout({ dataHome: directory, versionPath });
  await assertRejects(
    () => resolveManagedOmpExecutable({ dataHome: directory, versionPath }),
    Error,
    "is not materialized",
  );
  await Deno.mkdir(join(layout.root, "bin"), { recursive: true });
  await Deno.writeTextFile(layout.executable, "#!/bin/sh\nexit 0\n");
  await Deno.chmod(layout.executable, 0o755);
  await Deno.writeTextFile(
    layout.receipt,
    JSON.stringify({
      schemaVersion: 1,
      source: {
        repository: "https://example.invalid/omp.git",
        tag: "v1.2.3",
        commit: "wrong",
        packageVersion: "1.2.3",
      },
      executable: "bin/omp",
      materializedAt: new Date().toISOString(),
    }),
  );
  await assertRejects(
    () => resolveManagedOmpExecutable({ dataHome: directory, versionPath }),
    Error,
    "does not match pinned commit",
  );
  await Deno.writeTextFile(
    layout.receipt,
    JSON.stringify({
      schemaVersion: 1,
      source: {
        repository: "https://example.invalid/omp.git",
        tag: "v1.2.3",
        commit: "0123456789abcdef",
        packageVersion: "1.2.3",
      },
      executable: "bin/omp",
      materializedAt: new Date().toISOString(),
    }),
  );
  assertEquals(
    await resolveManagedOmpExecutable({ dataHome: directory, versionPath }),
    layout.executable,
  );
  await Deno.remove(directory, { recursive: true });
});

Deno.test("malformed OMP pins fail with their missing field", async () => {
  const directory = await Deno.makeTempDir();
  const versionPath = join(directory, "omp.version");
  await Deno.writeTextFile(versionPath, "repository=x\n");
  await assertRejects(
    () => loadOmpRuntimePin(versionPath),
    Error,
    "missing tag",
  );
  try {
    await loadOmpRuntimePin(join(directory, "missing"));
  } catch (error) {
    assertStringIncludes(String(error), "No such file");
  }
  await Deno.remove(directory, { recursive: true });
});
