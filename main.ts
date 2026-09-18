#!/usr/bin/env -S deno run -A

import { main } from "./src/cli.ts";
import { TextLogCapacityError } from "./src/log.ts";

if (import.meta.main) {
  try {
    await main(Deno.args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    Deno.exit(error instanceof TextLogCapacityError ? error.exitCode : 1);
  }
}
