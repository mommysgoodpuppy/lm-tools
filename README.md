# lm-tools

A personal Deno toolbox for the small scripts that inevitably accumulate around serving local
language models.

The initial CLI has three jobs:

- resumable, parallel downloads for large model files;
- a configurable `llama-server` launcher with the local Qwen setup as its current default;
- the OpenAI compatibility proxy needed by clients such as VS Code;
- an experimental native-AMD runner backed by a pinned vendored tinygrad snapshot.

The proxy normalizes empty function schemas and turns llama-server's raw reasoning stream into the
complete reasoning-summary event lifecycle expected by VS Code, including synthesized part and
completion events that llama-server does not emit itself. In combined VS Code mode it also parses
llama.cpp's real prompt-evaluation progress and shows it as a local-only reasoning trace while the
model is ingesting the request.

## Use

```bash
deno task lm --help
deno task lm download URL ./model.gguf
deno task lm llama --context 64k
deno task lm proxy
deno task lm vscode
deno task lm tinygrad --max_context 128 --benchmark 5
```

The launcher defaults to `127.0.0.1:8080`. The proxy defaults to `0.0.0.0:1235` and forwards to that
llama server, so a VS Code-compatible base URL is:

```text
http://<this-computer>:1235/v1
```

The proxy has no authentication. Keep port 1235 on a trusted network or change the listen host:

```bash
deno task lm proxy --listen-host 127.0.0.1
```

For VS Code on this machine, the combined command starts Qwen at 128K with the measured
K=q8_0/V=q4_0 cache balance, waits for llama-server to become healthy, and then starts a
localhost-only proxy:

```bash
deno task lm vscode
```

This Qwen generation uses hybrid DeltaNet/recurrent layers. On the RX 7900 XTX, llama.cpp's Vulkan
backend is required for practical prompt processing: the b10355 Vulkan build processed a 20K-token
128K-context probe at about 621 tokens/s, while the ROCm/HIP backend collapsed at context depth.

## Experimental tinygrad backend

The tinygrad checkout is intentionally ignored rather than stored directly or added as a submodule.
`vendor/tinygrad.version` pins the upstream commit and a small tracked patch preserves the recurrent
prefill experiment. Bootstrap it after cloning lm-tools:

```bash
deno task tinygrad:vendor
```

The runner uses tinygrad's native `AMD` backend directly—ROCm Python packages are not required:

```bash
# Defaults to the local Qwen3.8-27B Q4_K_M file on this machine.
deno task lm tinygrad --max_context 4096 --benchmark 5

# Exercise chunked recurrent prefill; upstream currently forces a chunk size of one.
deno task lm tinygrad --recurrent-chunk 16 --max_context 4096 --serve 8000
```

Qwen3.5-0.8B and the local Qwen3.8-27B both run correctly on the RX 7900 XTX. Untuned steady-state
decode measured about 151 tok/s and 1.9 tok/s respectively. Chunking recurrent prefill by 16 raised
a repeated 133-token 0.8B probe from 164 to 667 tok/s, but the 27B model managed only about 11 tok/s
on a repeated 173-token probe. It is therefore functional but not yet competitive with llama.cpp
Vulkan for interactive use or large VS Code prompts.

Do not enable `JITBEAM` on this machine for now: searching 27B kernels hit an AMD queue timeout and
caused a hard reset. The recurrent chunk override is opt-in and retains tinygrad's upstream
chunk-size-one default.

To make `lm` available globally:

```bash
deno install --global -A --name lm main.ts
```

## Llama examples

```bash
# Current local Qwen default, 64K context and q8_0 KV cache
deno task lm llama

# Another GGUF, mixed KV cache, and extra raw llama.cpp options
deno task lm llama /models/model.gguf --context 128k --kv-k q8_0 --kv-v q4_0 -- --verbose

# Inspect the exact command without starting the server
deno task lm llama --dry-run
```

Environment overrides retained from `lm-download` are `MODEL_PATH`, `LLAMA_SERVER`, `PORT`,
`CONTEXT_SIZE`, `KV_CACHE_TYPE`, `KV_CACHE_TYPE_K`, and `KV_CACHE_TYPE_V`.

## Development

```bash
deno task verify
```

## Migration notes

This starts the migration without pretending the experimental pieces are stable interfaces:

- `parallel_download.py` is now the `download` command and no longer needs Python or `requests`.
- `qwen_llama.ts` / `run_qwen_llama.sh` are generalized into the `llama` command.
- `lm-studio-compat-proxy` is the `proxy` command; its default upstream is llama-server on
  port 8080.
- VRAM sweeps and automatic context fitting are the next natural llama-tooling module.
- The Qwen 3.5 vLLM GGUF monkey-patch stays outside the core until vLLM support is worth
  stabilizing.
