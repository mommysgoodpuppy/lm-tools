import { assertEquals } from "jsr:@std/assert@1/equals";
import { matchingProcesses, vramAdmission } from "./process_manager.ts";

Deno.test("exclusive GPU policy matches only declared conflicting executables", () => {
  const processes = [
    { pid: 10, executable: "/usr/bin/llama-server" },
    { pid: 11, executable: "/usr/bin/llama-server" },
    { pid: 12, executable: "/usr/bin/python" },
  ];
  assertEquals(matchingProcesses(processes, ["/usr/bin/llama-server"], 10), [
    { pid: 11, executable: "/usr/bin/llama-server" },
  ]);
});

Deno.test("VRAM admission includes expected use and remaining reserve", () => {
  const mib = 1024 * 1024;
  assertEquals(vramAdmission(24_000 * mib, 1_000 * mib, 21_000, 2_048).accepted, false);
  assertEquals(vramAdmission(24_576 * mib, 1_000 * mib, 21_000, 2_048).accepted, true);
});

Deno.test("shared GPU policy can skip conflict matching", () => {
  assertEquals(
    matchingProcesses([{ pid: 10, executable: "/usr/bin/llama-server" }], [], 99),
    [],
  );
});
