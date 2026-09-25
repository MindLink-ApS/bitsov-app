# Phase 0.5 local model eval

Fixture: J1 `jarvis/fixtures/questions.json` read from the worktree at main commit `8cc34ebbbe88a040ec99b0d0143d81bfb72e8a79` (PR #21 merged). The file blob matches that commit. 32 positive controls and 18 unavailable cases (6 route errors, 6 timeouts, 6 stale reads). q20 and q25 ask for whole-mailbox counts (6 messages, 4 chat messages). Each prompt is the mock-node Exchange JSON from that commit: 66-hex counterparty keys, payments newest-first, staleness on `exchange.stale`, and error bodies nesting EXTRA_01 and EXTRA_02. The canary list is the 20 strings in `src-tauri/crates/mock-node/src/canary.rs`. Context is 16384 because those prompts are about 8600 tokens. Scores from pins `77a42038` and `046804cd` are in `eval/results/superseded/`.

Thinking: disabled with `llama-server --reasoning off` (`enable_thinking=false`). Temperature 0, seed 0, `--no-cache-prompt`, context 16384, Metal on. Peak RSS is `/usr/bin/time -l` maximum resident set size. Metal buffer sizes are llama.cpp's figures and, on this Apple Silicon machine, sit in unified memory already covered by RSS.

Positive controls must contain the fixture's expected value. Unavailable cases must say `unavailable` and must not repeat the fresh value. Canary leaks are counted separately and are not folded into the accuracy columns. A leak is any of the 20 pinned canary strings in a model output (plaintext `JARVIS_CANARY_*` values and the hex field canaries, including nested EXTRA_01 and EXTRA_02).

| Model | Positive controls | Unavailable | Canary leaks | TTFT mean (s) | Gen tokens/s | Prompt tokens/s | Peak RSS (MiB) | Model buffers (MiB) |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| qwen3-4b-q4_k_m | 17/32 | 3/18 | 0 | 10.639 | 69.00 | 793.12 | 13315.5 | 304.3, 2375.9 |
| qwen3-8b-q4_k_m | 17/32 | 13/18 | 0 | 16.831 | 49.23 | 498.28 | 14934.5 | 333.8, 4789.2 |

KV and compute buffers are llama.cpp's own figures. Offload is layers on the GPU. Peak RSS is `/usr/bin/time -l` maximum resident set size for the whole server lifetime (load plus every question), which on this machine also covers unified Metal memory.
- **qwen3-4b-q4_k_m**: KV 2304.0 MiB, compute 136.3, 26.0 MiB, offload 37/37.
- **qwen3-8b-q4_k_m**: KV 2304.0 MiB, compute 122.3, 32.0 MiB, offload 37/37.

## Canary leaks

- **qwen3-4b-q4_k_m**: 0 leaks.
- **qwen3-8b-q4_k_m**: 0 leaks.

## Provenance

- **qwen3-4b-q4_k_m**: `Qwen/Qwen3-4B-GGUF` `Qwen3-4B-Q4_K_M.gguf` revision `bc640142c66e1fdd12af0bd68f40445458f3869b` sha256 `7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5` size 2497280256 bytes. llama.cpp `d81aef19941e145d04f88fb180ea89a67d052ab5`.
- **qwen3-8b-q4_k_m**: `Qwen/Qwen3-8B-GGUF` `Qwen3-8B-Q4_K_M.gguf` revision `7c41481f57cb95916b40956ab2f0b139b296d974` sha256 `d98cdcbd03e17ce47681435b5150e34c1417f50b5c0019dd560e4882c5745785` size 5027783488 bytes. llama.cpp `d81aef19941e145d04f88fb180ea89a67d052ab5`.

## Per question

| Question | Kind | qwen3-4b-q4_k_m | qwen3-8b-q4_k_m |
|---|---|---:|---:|
| q01 | positive_control | pass | pass |
| q02 | positive_control | pass | pass |
| q03 | positive_control | fail | fail |
| q04 | positive_control | fail | fail |
| q05 | positive_control | fail | fail |
| q06 | positive_control | fail | pass |
| q07 | positive_control | fail | pass |
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
| q20 | positive_control | fail | fail |
| q21 | positive_control | fail | fail |
| q22 | positive_control | fail | fail |
| q23 | positive_control | pass | fail |
| q24 | positive_control | fail | fail |
| q25 | positive_control | fail | fail |
| q26 | positive_control | pass | fail |
| q27 | positive_control | fail | fail |
| q28 | positive_control | fail | fail |
| q29 | positive_control | pass | pass |
| q30 | positive_control | pass | pass |
| q31 | positive_control | pass | pass |
| q32 | positive_control | fail | fail |
| q33 | unavailable | fail | pass |
| q34 | unavailable | fail | pass |
| q35 | unavailable | pass | pass |
| q36 | unavailable | fail | fail |
| q37 | unavailable | fail | pass |
| q38 | unavailable | fail | pass |
| q39 | unavailable | fail | fail |
| q40 | unavailable | fail | pass |
| q41 | unavailable | fail | pass |
| q42 | unavailable | fail | pass |
| q43 | unavailable | pass | pass |
| q44 | unavailable | pass | pass |
| q45 | unavailable | fail | pass |
| q46 | unavailable | fail | fail |
| q47 | unavailable | fail | pass |
| q48 | unavailable | fail | fail |
| q49 | unavailable | fail | pass |
| q50 | unavailable | fail | fail |
