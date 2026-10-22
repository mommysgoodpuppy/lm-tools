# AGENTS.md

lm-tools is a Deno toolkit (`lm`) for running local language models and the systems around them:
deployments, vendor builds, proxies, free-router, agent environments, claws, tasks and campaigns.

- `docs/`: settled user-facing documentation; LLM docs (usually more verbose and less reviewed) go
  in `markdown/`. Start with `README.md`, then `docs/concepts.md` and `docs/wtf.md`.
- `markdown/`: plans and work in progress.
- `markdown/issues/`: the bug tracker, one Markdown file per issue with a `Status:` line.
- `research/`: gitignored reference material: cloned reference projects, specs, papers and other
  relevant files. Read from it; do not commit it.
- Use `_scratch/` for agent scratch files, experiments and local test artifacts. It is ignored by
  Git. Global tmp may be used but is not persistent; project-local, don't use `project/tmp/` or
  others, only `_scratch/`.
- Check: `deno task check`. Test: `deno task test`. Before committing: `deno task verify` (fmt
  check, lint, type check, tests). Run: `deno task lm <command>`.
- This repository stays machine- and model-agnostic. Concrete deployments, vendor manifests,
  patches, base configs and service units belong to the consuming project, not here.
- `vendor/omp` and `vendor/t3code` are pinned submodules (`*.version` files record the pins); do not
  edit them in place. `deno task omp:check` verifies the OMP pin.
- Deployments take the GPU exclusively and evict conflicting servers. Do not start one while another
  model server or GPU benchmark is running unless that is the point.
- Proxy diagnostics and request captures (`logs/`, `results/`, `api-jsons/`) can contain full
  prompts and tool output. Never publish them.

## Related projects

- `../qwen-local`: consumes lm-tools. Owns the concrete Qwen deployments, vendor manifests
  (llama.cpp, hipfire), patches, `base.json` and the `lm-qwen.service` unit. lm-tools owns the
  schemas and the runtime that executes them.

## Git

Manage git however you see fit. Primary is `main`.

- Commit as the configured git identity. No `Co-Authored-By` or other co-author trailers.
- Never push, open PRs or issues, or publish anything to external sites unless asked for that
  specific action.
- End every agent-made commit message with:

  ```
  Agent: <harness> <version>; model <exact model id>; thread <harness thread/session id>
  ```

  For example,
  `Agent: Claude Code 2.1.296; model claude-opus-5-5; thread 941be8c7-aca1-4664-b284-7cc0eed69e21`.
