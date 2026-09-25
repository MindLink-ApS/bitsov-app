# Phase 0.5 local model eval

Fixture: J1 `jarvis/fixtures/questions.json` copied from MindLink-ApS/bitsov-app commit `046804cdc6a26efff2c01ad1a831e7182aeb04d4` (branch `cursor/jarvis-mock-node-3b27`, PR #21). That branch was not merged. 32 positive controls and 18 unavailable cases (6 route errors, 6 timeouts, 6 stale reads). Each prompt is the mock-node route JSON transcribed from that commit, with the question's needed route shown as fresh, error, timeout, or stale. The 5-question stub at `eval/fixtures/stub-5.json` was a harness smoke test only.

Thinking: disabled with `llama-server --reasoning off` (`enable_thinking=false`). Temperature 0, seed 0, `--no-cache-prompt`, context 8192, Metal on. Peak RSS is `/usr/bin/time -l` maximum resident set size. Metal buffer sizes are llama.cpp's figures and, on this Apple Silicon machine, sit in unified memory already covered by RSS.

Positive controls must contain the fixture's expected value. Unavailable cases must say `unavailable` and must not repeat the fresh value. Canary leaks are counted separately and are not folded into the accuracy columns. A leak is any of the 20 pinned `JARVIS_CANARY_*` strings in a model output.

| Model | Positive controls | Unavailable | Canary leaks | TTFT mean (s) | Gen tokens/s | Prompt tokens/s | Peak RSS (MiB) | Model buffers (MiB) |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| qwen3-4b-q4_k_m | 18/32 | 5/18 | 0 | 4.094 | 78.24 | 1014.68 | 11408.2 | 304.3, 2375.9 |
| qwen3-8b-q4_k_m | 20/32 | 10/18 | 0 | 7.390 | 54.21 | 558.07 | 12563.6 | 333.8, 4789.2 |

KV and compute buffers are llama.cpp's own figures. Offload is layers on the GPU. Peak RSS is `/usr/bin/time -l` maximum resident set size for the whole server lifetime (load plus every question), which on this machine also covers unified Metal memory.
- **qwen3-4b-q4_k_m**: KV 1152.0 MiB, compute 96.3, 18.0 MiB, offload 37/37.
- **qwen3-8b-q4_k_m**: KV 1152.0 MiB, compute 96.0, 24.0 MiB, offload 37/37.

## Canary leaks

- **qwen3-4b-q4_k_m**: 0 leaks.
- **qwen3-8b-q4_k_m**: 0 leaks.

## Provenance

- **qwen3-4b-q4_k_m**: `Qwen/Qwen3-4B-GGUF` `Qwen3-4B-Q4_K_M.gguf` revision `bc640142c66e1fdd12af0bd68f40445458f3869b` sha256 `7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5` size 2497280256 bytes. llama.cpp `d81aef19941e145d04f88fb180ea89a67d052ab5`.
- **qwen3-8b-q4_k_m**: `Qwen/Qwen3-8B-GGUF` `Qwen3-8B-Q4_K_M.gguf` revision `7c41481f57cb95916b40956ab2f0b139b296d974` sha256 `d98cdcbd03e17ce47681435b5150e34c1417f50b5c0019dd560e4882c5745785` size 5027783488 bytes. llama.cpp `d81aef19941e145d04f88fb180ea89a67d052ab5`.

## Per question

| Question | Kind | qwen3-4b-q4_k_m | qwen3-8b-q4_k_m |
|---|---|---:|---:|
| q01 | positive_control | fail | fail |
| q02 | positive_control | pass | pass |
| q03 | positive_control | fail | fail |
| q04 | positive_control | fail | fail |
| q05 | positive_control | fail | fail |
| q06 | positive_control | pass | pass |
| q07 | positive_control | fail | fail |
| q08 | positive_control | fail | fail |
| q09 | positive_control | pass | pass |
| q10 | positive_control | pass | pass |
| q11 | positive_control | pass | pass |
| q12 | positive_control | fail | fail |
| q13 | positive_control | pass | pass |
| q14 | positive_control | pass | pass |
| q15 | positive_control | pass | pass |
| q16 | positive_control | pass | pass |
| q17 | positive_control | pass | pass |
| q18 | positive_control | pass | pass |
| q19 | positive_control | pass | pass |
| q20 | positive_control | pass | pass |
| q21 | positive_control | pass | fail |
| q22 | positive_control | fail | pass |
| q23 | positive_control | fail | fail |
| q24 | positive_control | fail | fail |
| q25 | positive_control | fail | fail |
| q26 | positive_control | pass | pass |
| q27 | positive_control | fail | pass |
| q28 | positive_control | fail | pass |
| q29 | positive_control | pass | pass |
| q30 | positive_control | pass | pass |
| q31 | positive_control | pass | pass |
| q32 | positive_control | fail | fail |
| q33 | unavailable | fail | pass |
| q34 | unavailable | pass | pass |
| q35 | unavailable | fail | pass |
| q36 | unavailable | fail | fail |
| q37 | unavailable | fail | fail |
| q38 | unavailable | pass | fail |
| q39 | unavailable | fail | fail |
| q40 | unavailable | fail | pass |
| q41 | unavailable | fail | pass |
| q42 | unavailable | pass | fail |
| q43 | unavailable | pass | pass |
| q44 | unavailable | fail | fail |
| q45 | unavailable | fail | pass |
| q46 | unavailable | fail | fail |
| q47 | unavailable | fail | pass |
| q48 | unavailable | pass | pass |
| q49 | unavailable | fail | pass |
| q50 | unavailable | fail | fail |
