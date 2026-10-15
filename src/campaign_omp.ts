import { dirname, join } from "jsr:@std/path@1";
import type { ResolvedAgentEnvironment } from "./agent_environment.ts";
import { runEnvironmentAction } from "./agent_environment.ts";
import type { AttemptIdentity, AttemptRecord, CampaignContext } from "./campaign.ts";
import {
  type AttemptRun,
  type AttemptRunOptions,
  type CampaignLedger,
  runAttemptOnce,
} from "./harness_attempt.ts";

export interface OmpCampaignAttempt {
  /** Campaign-defined identity. The adapter deliberately does not interpret its inputs. */
  identity: AttemptIdentity;
  environment: ResolvedAgentEnvironment;
  prompt: string;
  /** OMP model selector for this attempt; include it in identity.inputs for attribution. */
  model?: string;
  /** Native OMP profile files, staged per attempt and preserved as artifacts. */
  profileFiles?: Readonly<Record<string, string>>;
  /** Additional process environment; PI_CODING_AGENT_DIR is owned by profileFiles. */
  guestEnvironment?: Readonly<Record<string, string>>;
  /** Reconcile the declared Incus environment before staging and running OMP. */
  reconcileEnvironment?: boolean;
}

export interface OmpAttemptResult {
  run: AttemptRun;
  ledger: CampaignLedger;
}

export type OmpAttemptRunner = (
  environment: ResolvedAgentEnvironment,
  options: AttemptRunOptions,
) => Promise<OmpAttemptResult>;

function safeProfilePath(path: string): string {
  const segments = path.split("/");
  if (!path || path.startsWith("/") || segments.some((segment) => !segment || segment === "..")) {
    throw new Error(`OMP profile path must be a safe relative path: ${path}`);
  }
  return path;
}

async function stageProfile(
  environment: ResolvedAgentEnvironment,
  hostDirectory: string,
  guestDirectory: string,
  files: Readonly<Record<string, string>>,
): Promise<void> {
  const { backend, guest } = environment.config;
  for (
    const [relativePath, content] of Object.entries(files).sort(([left], [right]) =>
      left.localeCompare(right)
    )
  ) {
    const safePath = safeProfilePath(relativePath);
    const hostPath = join(hostDirectory, safePath);
    const guestPath = join(guestDirectory, safePath);
    await Deno.mkdir(dirname(hostPath), { recursive: true });
    await Deno.writeTextFile(hostPath, content, { createNew: true });
    const output = await new Deno.Command(backend.executable, {
      args: [
        "file",
        "push",
        "--create-dirs",
        "--uid",
        String(guest.uid),
        "--gid",
        String(guest.gid),
        hostPath,
        `${backend.instance}${guestPath}`,
      ],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!output.success) {
      throw new Error(
        `Could not stage OMP profile ${safePath}: ${
          new TextDecoder().decode(output.stderr).trim()
        }`,
      );
    }
  }
}

/**
 * Execute an OMP turn as one durable campaign effect.
 *
 * The campaign program owns identity, branching, interpretation, validation, and
 * follow-up. This adapter only materializes the prompt, invokes the stable
 * environment/harness abstraction, and captures the raw operational record.
 */
export async function runOmpCampaignAttempt(
  context: CampaignContext,
  attempt: OmpCampaignAttempt,
  runner: OmpAttemptRunner = runAttemptOnce,
): Promise<AttemptRecord> {
  return await context.attempt(attempt.identity, async (workspace) => {
    if (attempt.reconcileEnvironment) {
      await runEnvironmentAction(attempt.environment, "apply");
    }
    const promptPath = join(workspace.artifactsDirectory, "prompt.md");
    const harnessDirectory = join(workspace.artifactsDirectory, "harness");
    const nativeDirectory = join(workspace.artifactsDirectory, "native");
    let guestProfileDirectory: string | undefined;
    await Deno.writeTextFile(promptPath, attempt.prompt, { createNew: true });
    const guestEnvironment = { ...(attempt.guestEnvironment ?? {}) };
    if (attempt.profileFiles) {
      if ("PI_CODING_AGENT_DIR" in guestEnvironment) {
        throw new Error("PI_CODING_AGENT_DIR is controlled by OMP profileFiles");
      }
      const hostProfileDirectory = join(workspace.artifactsDirectory, "omp-profile");
      guestProfileDirectory = join(
        attempt.environment.config.guest.workspace,
        ".lm-tools",
        "profiles",
        workspace.id,
      );
      await stageProfile(
        attempt.environment,
        hostProfileDirectory,
        guestProfileDirectory,
        attempt.profileFiles,
      );
      guestEnvironment.PI_CODING_AGENT_DIR = guestProfileDirectory;
      await Deno.writeTextFile(
        join(workspace.artifactsDirectory, "omp-invocation.json"),
        `${JSON.stringify({ guestProfileDirectory, guestEnvironment }, null, 2)}\n`,
        { createNew: true },
      );
    }

    const { run } = await runner(attempt.environment, {
      promptText: attempt.prompt,
      metricsDirectory: harnessDirectory,
      captureDirectory: nativeDirectory,
      guestEnvironment,
      model: attempt.model,
      guestProfileDirectory,
    });
    return {
      termination: run.timedOut
        ? { kind: "timeout", exitCode: run.exitCode }
        : { kind: "completed", exitCode: run.exitCode },
      usage: run.usage,
    };
  });
}
