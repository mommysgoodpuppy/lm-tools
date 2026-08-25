# Qwen3.8 quant and DFlash 2 design

This is the machine-specific decision record for the RX 7900 XTX Qwen3.8-27B deployment. It was
researched and tested on 2026-08-22.

## Quant choice

The deployment uses Unsloth `UD-Q4_K_XL` at 17,559,178,144 bytes. Unsloth recommends this Dynamic
GGUF as its quality/memory default for Qwen3.8-27B. It assigns precision selectively rather than
quantizing every tensor identically. The extra 1.09 GB over Unsloth's `UD-Q4_K_M` is worthwhile on
this 24 GB card because model quality, not fitting the smallest possible artifact, is the goal.

Alternatives considered:

- NVFP4 is an attractive high-throughput option on NVIDIA Blackwell (RTX 50, DGX Spark, B200/B300),
  but it is not the native format for the AMD RDNA3 GPU in this machine.
- Unsloth's dynamic `IQ1_S` and `IQ1_M` are unusually capable for their 6.19 and 6.73 GB sizes and
  are useful capacity fallbacks. Their architectural luck does not make one-bit weights preferable
  when a higher-quality 4-bit model fits entirely in VRAM.
- The previous community `Q4_K_M` is 16.81 GB. `UD-Q4_K_XL` costs only about 0.75 GB more while
  following Unsloth's current per-tensor quantization recipe.

The context window is 102,400 tokens rather than 131,072. That remains ample for the coding-agent
workload while returning memory to the higher-quality target weights, the DFlash drafter, and a real
safety margin.

References:

- <https://unsloth.ai/models/qwen3.8-27b>
- <https://unsloth.ai/docs/basics/unsloth-dynamic-2.0-ggufs>
- <https://huggingface.co/unsloth/Qwen3.8-27B-GGUF>

## DFlash 2 integration

DFlash 2 is lossless speculative decoding, not another target-model quant. A matched 2B draft model
proposes a block in parallel; Qwen verifies the proposals, so accepted output retains the target
model's greedy result or sampling distribution. DFlash 2 adds dynamic local convolution and a
candidate-path selector to reduce acceptance decay within and across long blocks.

The llama.cpp implementation is still in upstream PR 27342. The repository therefore pins that PR
head in `vendors/llama-dflash2.json`, builds it locally with Vulkan, and leaves
`/usr/bin/llama-server` untouched. The experimental deployment uses the official Q4_K_M draft
(1,143,006,752 bytes) and a conservative four-token draft width. Published H200 results favor seven,
but the local measurements below favor four on this GPU and deep-context workload. Width is a
hardware/workload tuning parameter, not a quality setting.

Bootstrap and verify the reproducible setup with:

```bash
deno task dflash2:vendor
deno task lm deploy deployments/qwen-vscode-dflash2.json --fetch
deno task lm deploy deployments/qwen-vscode-dflash2.json --check
deno task lm deploy deployments/qwen-vscode-dflash2.json --dry-run
```

References:

- <https://inco.ai/blog/dflash2/>
- <https://huggingface.co/z-lab/Qwen3.8-27B-DFlash2>
- <https://huggingface.co/incoai/Qwen3.8-27B-DFlash2-GGUF>
- <https://github.com/ggml-org/llama.cpp/pull/27342>

## Local test matrix

The pinned artifacts passed size and SHA-256 verification. The tests used 102,400 configured
context, q8_0/q4_0 KV, Vulkan, a single slot, identical sampling/request data, and a 512-token
output cap. The replay was a captured real coding-agent request containing 61,502 input tokens.

### Target quant comparison

The quant comparison used the system llama.cpp build and MTP width two, except for `UD-IQ1_M`, whose
GGUF has no MTP layers and therefore ran autoregressively. Total VRAM is whole-device usage,
including about 1,296 MiB occupied by the desktop.

| Target quant               | Prompt tok/s | Decode tok/s | Acceptance | Total wall | Total VRAM |
| -------------------------- | -----------: | -----------: | ---------: | ---------: | ---------: |
| Unsloth `UD-IQ1_M`, no MTP |       485.31 |        36.12 |          - |   140.95 s | 10,176 MiB |
| Unsloth `UD-Q4_K_M`        |       468.40 |        52.43 |      86.1% |   141.05 s | 19,964 MiB |
| Community `Q4_K_M`         |       468.13 |        53.22 |      79.7% |   141.05 s | 20,304 MiB |
| Unsloth `UD-Q4_K_XL`       |       470.91 |        49.60 |      78.6% |   140.99 s | 21,009 MiB |

All three Q4 variants were effectively tied end to end. The per-run generation rate varies with the
sampled output and its MTP acceptance, so it is not evidence that either Q4_K_M target is
intrinsically faster. `UD-Q4_K_XL` uses the intended 20--22 GB envelope, preserves the highest
quality of the tested quants, and gives up no measured end-to-end speed. `UD-IQ1_M` is a useful
low-memory fallback, but leaves roughly half of the 24 GB card unused and decodes more slowly
without MTP.

### Speculator comparison

The DFlash 2 implementation requires its pinned llama.cpp fork. An MTP control on that same fork is
included so the backend-build difference is not credited to the speculator.

| Arm                      | Prompt tok/s | Decode tok/s | Acceptance | Mean span | Total wall | Total VRAM |
| ------------------------ | -----------: | -----------: | ---------: | --------: | ---------: | ---------: |
| MTP, width 2             |       471.90 |        45.70 |      75.0% |      2.50 |   141.59 s | 21,024 MiB |
| DFlash 2 Q4_K_M, width 4 |       450.02 |        45.54 |      57.7% |      3.30 |   147.97 s | 21,871 MiB |
| DFlash 2 Q4_K_M, width 7 |       461.33 |        37.24 |      42.9% |      3.98 |   147.12 s | 22,318 MiB |

All requests returned HTTP 200 and stopped normally at 512 output tokens. DFlash 2 loaded and ran
correctly. Width four was effectively tied with the fork's MTP control on decode, but was 4.6%
slower on prefill, 4.5% slower end to end, and used 847 MiB more VRAM. The published reference width
of seven was worse on this GPU and workload: acceptance fell to 42.9%, decode fell to 37.24 tok/s,
and VRAM rose another 447 MiB. The experimental deployment therefore retains width four.

DFlash's first initialization in the new fork took 151 seconds while Vulkan pipelines were prepared,
versus 7 seconds for MTP after the fork was built and cached. This is a one-time pipeline
preparation cost, not the recurring warm-start time.

The canonical `/usr/bin/llama-server` was also smoke-tested with the selected target, full
102,400-token allocation, and MTP width two. It became healthy in 7.6 seconds and returned the
requested `READY` response with HTTP 200.

The canonical deployment therefore keeps MTP width two. DFlash 2 remains a complete separate
deployment for future llama.cpp updates, drafter quant changes, or prompt-specific width sweeps.

## tinygrad RDNA3 experiment

The tinygrad investigation reproduced and exceeded the reported 34 tok/s shallow-decode result.
The working combination is PR 17512 at commit
`2015a4f4a79a3eb382b91e1cc506a130ace7deb2` plus the archived, non-dynamic Qwen3.8-27B
`IQ4_XS` artifact (15,705,861,088 bytes on disk, SHA-256
`9fd40d7036f5e0918e20aaeebf11468fafd06bb53d4d980eef6bb7e4e4ace666`). Its mostly
IQ4_XS/Q5_K tensor mix follows the hand-written kernels in the PR, unlike the newer Unsloth
Dynamic-v3 artifact.

| tinygrad arm | Context | Prompt tok/s | Decode tok/s | Wall | Peak VRAM |
| --- | ---: | ---: | ---: | ---: | ---: |
| Standard `IQ4_XS`, shallow decode | 102,400 | - | 44.3--44.7 | - | 19,291 MB reported by tinygrad |
| Standard `IQ4_XS`, captured 61,514 + 512 request | 102,400 | 192 | 28 | 338.92 s | 20,943 MiB whole device |
| Dynamic-v3 `UD-IQ4_XS`, `JIT=2` diagnostic | 102,400 | - | 2.60 | - | 18,550 MB reported by tinygrad |
| Dynamic-v3 `UD-IQ4_XS`, `JIT=1` | 102,400 | - | 3.68--3.69 | - | 18,550 MB reported by tinygrad |

The UD artifact initially triggered a recoverable AMD hardware fault during graph warmup. Repeated
diagnostics subsequently completed with both unbatched `JIT=2` and batched `JIT=1`; the fault was
not stable enough to assign to a graph-size boundary. More importantly, UD is over ten times slower
than standard IQ4_XS because many of its mixed quant types miss PR 17512's specialized packed
matmul path. Further UD tuning is out of scope for the best-current-tinygrad track.

On the same captured request, llama.cpp Vulkan with `UD-Q4_K_XL` remained the production winner:
470.91 prefill tok/s, 49.60 decode tok/s, and 140.99 seconds total. tinygrad is now genuinely usable
and interesting for kernel work, but its long-prompt performance does not yet justify replacing the
llama.cpp deployment.

PR 16668's experimental RDNA3 compiler backend is pinned separately in
`vendors/tinygrad-rdna3-backend.json`. Its exact head passed the trivial test used in the upstream
Strix Halo crash report and then the complete 21-test `test/test_tiny.py` smoke suite on this 7900
XTX (two tests skipped).

An exact-SHA merge-tree comparison found only two textual conflicts between PR 16668 and PR 17512:
`tinygrad/llm/model.py` and an attention test. That understates the integration work. In a disposable
worktree, PR 17512's Qwen kernel modules passed all six AMD kernel tests with `DEV=AMD`, but five of
six failed at compile time with `DEV=AMD:RDNA3`. Representative failures were missing register
assignments during assembly and unsupported register-index lowering. No GPU fault occurred. The
remaining work is to extend PR 16668's instruction selector/register allocator for the Qwen UOp
kernels; a mechanical PR merge alone cannot produce a runnable Qwen backend.
