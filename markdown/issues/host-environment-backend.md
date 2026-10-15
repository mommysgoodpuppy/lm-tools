# Host (non-Incus) environment backend

Status: open; lower priority than adapting attempt harnesses to the campaign API Created: 2026-09-18
Scope: lm-tools

## Problem

`agent-environment.schema.json` validates `backend.kind` as `const: "incus"`, and the
service/attempt machinery is Incus-bound (`guestUserCommand`, guest systemd user units, `incus exec`
prefixes hardcoded in `runOmpRpcTurn` / `runPiRpcTurn` / `runExecJsonTurn`). A declared claw is
supposed to compose "an environment which may or may not be an Incus container" (concepts.md), and
cheap classification/review attempts do not need a container at all.

## Proposed direction

1. Schema: `backend.kind: "host"` with `workspace`, env allowlist; no instance/network/limits fields
   (or optional host resource caps).
2. Transport refactor: build the exec argv as `backend.kind === "incus" ? [incus, exec, ...] : []`
   in the three attempt transports; spawn directly under the existing `/usr/bin/timeout` wrapper on
   host.
3. Service harness on host: write a host `systemctl --user` unit (`buildServiceUnit` already renders
   the unit text) instead of a guest unit; secrets target inside the host home; `hostServices`
   semantics unchanged.
4. Isolation honesty: a host backend's isolation is cwd sandbox + tool allowlist + approval policy
   only. Concepts.md should state that anything with shell access stays in a container trust class.

## Caution

- Host service harnesses share the user's systemd session; restart/prevent exit-status semantics
  must be re-checked against user units (linger, `systemctl --user` availability over ssh).
- Do not let host backends silently weaken the secrets boundary: `secretInputs` targets must stay
  outside the workspace and mode `0600`.
