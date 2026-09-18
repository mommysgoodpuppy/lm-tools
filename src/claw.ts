import { Ajv2020, type ErrorObject } from "npm:ajv@8.17.1/dist/2020.js";
import { dirname, resolve } from "jsr:@std/path@1";
import {
  type AgentEnvironmentConfig,
  environmentUsage,
  type ResolvedAgentEnvironment,
  runEnvironmentAction,
} from "./agent_environment.ts";
import { loadDeployment } from "./deployment.ts";

const PROJECT_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const CLAW_SCHEMA = `${PROJECT_ROOT}/schemas/claw.schema.json`;
const ENVIRONMENT_SCHEMA = `${PROJECT_ROOT}/schemas/agent-environment.schema.json`;

export interface ClawConfig {
  $schema?: string;
  version: 2;
  name: string;
  inference: {
    modelDeployment?: string;
    freeRouter?: string;
  };
  harness: AgentEnvironmentConfig["harness"];
  environment: Pick<
    AgentEnvironmentConfig,
    "backend" | "guest" | "exposure" | "hostServices" | "readOnlyMounts" | "seeds"
  >;
  observability?: {
    journalPath: string;
    maximumJournalBytes?: number;
  };
}

function formatAjvErrors(errors: ErrorObject[] | undefined | null): string {
  return (errors ?? [])
    .map((error) => `  ${error.instancePath || "/"} ${error.message}`)
    .join("\n");
}

export function clawAction(
  action: string,
):
  | "check"
  | "dry-run"
  | "apply"
  | "refresh"
  | "service-start"
  | "service-restart"
  | "service-stop"
  | "status" {
  switch (action) {
    case "check":
    case "dry-run":
    case "apply":
    case "refresh":
    case "status":
      return action;
    case "start":
      return "service-start";
    case "restart":
      return "service-restart";
    case "stop":
      return "service-stop";
    default:
      throw new Error(`Unknown claw action: ${action}`);
  }
}

export async function loadClaw(path: string): Promise<ResolvedAgentEnvironment> {
  const sourcePath = resolve(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await Deno.readTextFile(sourcePath));
  } catch (error) {
    throw new Error(
      `Could not read claw manifest ${sourcePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const schema = JSON.parse(await Deno.readTextFile(CLAW_SCHEMA));
  const environmentSchema = JSON.parse(await Deno.readTextFile(ENVIRONMENT_SCHEMA));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.addSchema(environmentSchema);
  const validate = ajv.compile(schema);
  if (!validate(parsed)) {
    throw new Error(`Invalid claw manifest ${sourcePath}:\n${formatAjvErrors(validate.errors)}`);
  }
  const claw = parsed as ClawConfig;
  if (claw.harness?.kind !== "service") {
    throw new Error(
      `A claw requires a service harness ${sourcePath}: harness.kind must be "service"`,
    );
  }
  if (claw.inference.freeRouter) {
    await Deno.stat(resolve(dirname(sourcePath), claw.inference.freeRouter));
  }
  const environmentConfig: AgentEnvironmentConfig = {
    version: 2,
    name: claw.name,
    modelDeployment: claw.inference.modelDeployment ?? "",
    seedOnCreate: true,
    backend: claw.environment.backend,
    guest: claw.environment.guest,
    harness: claw.harness,
    ...(claw.environment.exposure ? { exposure: claw.environment.exposure } : {}),
    ...(claw.environment.hostServices ? { hostServices: claw.environment.hostServices } : {}),
    ...(claw.environment.readOnlyMounts ? { readOnlyMounts: claw.environment.readOnlyMounts } : {}),
    seeds: claw.environment.seeds ?? [],
  };
  const model = claw.inference.modelDeployment
    ? await loadDeployment(resolve(dirname(sourcePath), claw.inference.modelDeployment))
    : null;
  return { sourcePath, config: environmentConfig, model };
}

export function clawUsage(): string {
  return `Usage: lm claw CONFIG ACTION

Manage a declared claw: an unbounded standing agent composed of inference, a
service harness, and an isolation environment. See docs/concepts.md.

Actions:
  --check     Validate the claw manifest and its referenced inference artifacts
  --dry-run   Print the resolved reconciliation and seed plan
  --apply     Create/reconcile and start the declared environment and harness
  --start     Start/reconcile the service harness, its exposure, and host services
  --restart   Refresh secrets/configuration and restart the service harness
  --stop      Stop the service harness and remove its exposure
  --refresh   Refresh control files, host services, harness, and exposure
  --status    Show the environment and its configured devices
  --help      Show this help

${environmentUsage().split("\n").slice(0, 1).join("\n")}`;
}

export async function clawCommand(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(clawUsage());
    return;
  }
  let path: string | undefined;
  let action: string | undefined;
  for (const arg of args) {
    if (arg.startsWith("--")) {
      if (action !== undefined) throw new Error("Select exactly one claw action");
      action = arg.slice(2);
    } else if (path !== undefined) {
      throw new Error("Only one claw CONFIG is accepted");
    } else path = arg;
  }
  if (!action) throw new Error(`A claw action is required\n\n${clawUsage()}`);
  if (!path) throw new Error(`A claw CONFIG is required\n\n${clawUsage()}`);
  const environment = await loadClaw(path);
  if (action === "check") {
    console.log(`Valid claw manifest: ${environment.config.name} (${environment.sourcePath})`);
    return;
  }
  await runEnvironmentAction(environment, clawAction(action));
}
