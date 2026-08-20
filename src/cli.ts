import { killEverythingCommand, killEverythingUsage } from "./cleanup.ts";
import { downloadCommand, downloadUsage } from "./download.ts";
import { deployCommand, deployUsage } from "./deployment.ts";
import { environmentCommand, environmentUsage } from "./agent_environment.ts";
import { llamaCommand, llamaUsage } from "./llama.ts";
import { proxyCommand, proxyUsage } from "./proxy.ts";
import { tinygradCommand, tinygradUsage } from "./tinygrad.ts";
import { vscodeCommand, vscodeUsage } from "./vscode.ts";

const VERSION = "0.1.0";

function usage(): string {
  return `lm ${VERSION} — Ellie's local model toolbox

Usage:
  lm <command> [options]

Commands:
  download  Resumable parallel download for large model files
  deploy    Validate and run a declarative model deployment
  env       Manage a declarative isolated agent environment
  kill-everything  Stop all configured model services and inference processes
  llama     Launch llama-server with useful local defaults
  proxy     Adapt OpenAI-compatible traffic for clients such as VS Code
  tinygrad  Run the experimental vendored tinygrad LLM backend
  vscode    Start the 128K Qwen llama/proxy stack for VS Code

Run \"lm <command> --help\" for command-specific help.`;
}

export async function main(args: string[]): Promise<void> {
  const [command, ...commandArgs] = args;

  switch (command) {
    case "download":
      await downloadCommand(commandArgs);
      return;
    case "deploy":
      await deployCommand(commandArgs);
      return;
    case "env":
    case "environment":
      await environmentCommand(commandArgs);
      return;
    case "kill-everything":
      await killEverythingCommand(commandArgs);
      return;
    case "llama":
    case "serve":
      await llamaCommand(commandArgs);
      return;
    case "proxy":
      await proxyCommand(commandArgs);
      return;
    case "tinygrad":
      await tinygradCommand(commandArgs);
      return;
    case "vscode":
      await vscodeCommand(commandArgs);
      return;
    case "help": {
      const [topic] = commandArgs;
      console.log(
        topic === "download"
          ? downloadUsage()
          : topic === "deploy"
          ? deployUsage()
          : topic === "env" || topic === "environment"
          ? environmentUsage()
          : topic === "kill-everything"
          ? killEverythingUsage()
          : topic === "llama" || topic === "serve"
          ? llamaUsage()
          : topic === "proxy"
          ? proxyUsage()
          : topic === "tinygrad"
          ? tinygradUsage()
          : topic === "vscode"
          ? vscodeUsage()
          : usage(),
      );
      return;
    }
    case "--version":
    case "-V":
      console.log(VERSION);
      return;
    case "--help":
    case "-h":
    case undefined:
      console.log(usage());
      return;
    default:
      throw new Error(`Unknown command: ${command}\n\n${usage()}`);
  }
}
