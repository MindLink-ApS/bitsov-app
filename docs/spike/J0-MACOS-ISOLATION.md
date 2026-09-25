# J0 Lane 1 — Phase 0.5 macOS isolation spike (mock only)

| | |
|---|---|
| Date | 2026-09-25 |
| Branch / base | `spike/j0-macos-isolation` from `origin/main` `0190baa` |
| Host | Apple M4 Max, macOS 26.6.2 (25G83), SIP enabled, Developer Mode off, user in `_developer` |
| Scope | ARCHITECTURE §3.1 isolation contract, ROADMAP Phase 1 "Isolation — reads" and "Isolation — writes", for the **assistant** and **LLM runtime** children |
| Rules kept | Mock only. No node, wallet, seed, relay, cloud, sidecar or Tauri run. Port 3141 never bound or used. All canaries lived under fresh `mktemp -d /tmp/j0-canary-*` dirs, which were deleted afterwards. The throwaway keychain was created, used and deleted by its exact path; the login keychain and search list were never touched (the before/after check is in the runner). No GUI automation. |

**VERDICT: ALL REQUIRED CONTROLS ENFORCEABLE ON macOS**

The verdict covers the assistant and LLM-runtime children on this machine and OS version. Other children (speech, TTS, embedding, plugins, parsers) and other macOS versions were not tested. See the residual risks below.

---

## 1. Mechanism choice

**Chosen: Seatbelt (the kernel `Sandbox.kext` MAC policy) with a custom SBPL profile, applied by the broker to each child just before `exec`, using `sandbox_init_with_parameters()`.**

In the spike, `scripts/spike/j0spawn.c` does the launching. `sandbox-exec -f` applies the same profile and is used as the leak control. Phase 1 would reproduce `j0spawn` in about 60 lines of Rust in the bitsov-app broker, in the child side of `fork`, before `execve`. The same steps as the spike launcher:

1. Put the per-spawn secret in the bootstrap pipe on fd 3.
2. Close every other descriptor.
3. Replace the environment with a fixed minimal one.
4. Apply the profile.
5. Call `execve`.

| Option | Enforceable for this contract? | Signing / packaging | Status | Decision |
|---|---|---|---|---|
| **Custom SBPL profile via `sandbox_init_with_parameters` (or `sandbox-exec`)** | **Yes: every control in §3.1 was enforced and tested (below).** Rules are per path, per socket path, per mach service, per IOKit class and per process target. The sandbox is inherited by every descendant and cannot be lifted from inside. | None. It works on unsigned or ad-hoc binaries such as the llama.cpp build. It does not interact with the app's own signing or notarization. | `sandbox-exec(1)` and `sandbox_init(3)` are documented as **DEPRECATED** (the man page, dated 2017, points to App Sandbox). `sandbox_init_with_parameters` is exported by `libsystem_sandbox` but is not in the public header. It still works on macOS 26.6.2, and macOS itself ships and relies on it: `/System/Library/Sandbox/Profiles/*.sb`, plus `dyld-support.sb`, which this profile imports. Chromium, Firefox, Bazel, Nix and several coding-agent CLIs confine child processes this way. | **Chosen.** Only this option can express the contract: one writable scratch dir, the weights read-only, exactly one unix socket, no loopback TCP, no mach services, no signals or inspection. |
| App Sandbox (entitlements) on an ad-hoc-signed helper | **Partly.** There is no way to say "allow this one unix socket but no loopback TCP": `network.client` is all-or-nothing, and unix-socket access outside the container needs temporary-exception entitlements. File access to the weights and socket paths also needs `temporary-exception.files.absolute-path.*`, which App Review disallows and Apple discourages. A container is forced into `~/Library/Containers/<id>`. Mach lookups cannot be denied more tightly than the App Sandbox baseline, which still allows many system services. Signals and process-info to same-user processes are governed by the baseline, not by a profile. | Each helper binary needs a bundle identifier and an entitlements plist, and must be code-signed. Ad-hoc signing works locally; distribution needs Developer ID and notarization of every helper, including a rebuilt llama.cpp. | Supported and not deprecated. | **Rejected as primary.** It cannot express "no loopback" together with "one socket", and it forces a container. It remains the fallback if Apple ever removes custom profiles. (Not executed in this spike: running it would create a persistent `~/Library/Containers` entry outside the allowed paths.) |
| Separate macOS user per child | Removes same-user signals and debugging, and adds file ownership. It does **not** stop loopback TCP to the node port or connects to `control.sock` when permissions allow, and it does not stop mach lookups. | Needs an admin-created user at install time and a privileged helper. | Supported. | Rejected: it needs root, is heavy for a consumer app, and does not cover the network or IPC controls. Could be layered on later. |
| Virtualization.framework VM | Strong, but it cannot use the host GPU through Metal in a way llama.cpp can use today. | Needs the virtualization entitlement (signed). | Supported. | Rejected for the LLM (no Metal). Over-scoped for the assistant. |

**What Phase 1 would ship on macOS:** `scripts/spike/j0-confined-child.sb`, embedded as a resource. The broker's Rust spawn path applies it to the assistant (`ROLE=assistant`) and to llama.cpp (`ROLE=llm`) with per-spawn parameters (scratch, IPC dir, listen dir, exec dir, weights). The broker **fails closed**: if `sandbox_init_with_parameters` returns non-zero, the child is never exec'd and no assistant runs (ARCHITECTURE §3.1). A startup self-test should run a reduced version of `run-isolation-tests.sh` (for example node-port connect, data-dir read and scratch write) and refuse to start the assistant if any control is not in force.

**Deprecation risk:** Apple could remove `sandbox_init*` or change SBPL. Mitigations:

- Import Apple's own `dyld-support.sb` rather than copying cryptex paths. This was needed on macOS 26: without it, dyld aborts before `main` because it cannot map the shared cache from `/System/Volumes/Preboot/Cryptexes/OS`.
- Run the isolation suite in CI on each supported macOS version.
- Fail closed.
- Keep App Sandbox as the fallback plan.

---

## 2. How the tests work

`scripts/spike/run-isolation-tests.sh` is self-contained and re-runnable. It exits 0 only if every control passes. Each run:

1. **Builds** `j0spawn` (launcher), `j0probe` (attacker) and `dummy_broker` into a fresh `/tmp/j0-canary-XXXX/bin`. `dummy_broker` is ad-hoc signed with `get-task-allow`, so an *unconfined* debugger can attach and the debugger baseline is meaningful.
2. **Creates disposable canaries** with random contents in:
   - `hostcode/`: fake app binary and `canary.txt`
   - `hostconfig/`: fake `tauri.conf.json`
   - `nodedata/`: `canary.txt`, `wallet.db`, `pairing/challenge-0001.txt`, `pairing/owner-console.nonce`
   - `sibling-child/`
   - `weights/`
   - the other child's scratch dir
   - the canary root
3. **Starts `dummy_broker`**. It listens on:
   - a **kernel-chosen loopback TCP port** (the fake node port). It refuses 3141; the recorded run got 50150.
   - `nodedata/control.sock`
   - `ipc/llm.sock` and `ipc/broker.sock` (positive controls)

   It counts every accepted connection and every SIGUSR1 it receives.
4. **Creates the throwaway keychain** with a random password: `security create-keychain -p <random> /private/tmp/j0-canary-XXXX/keychain/j0-throwaway.keychain-db`. It then adds a generic-password item with `-A` (any app may read it without a prompt), so the only thing that can stop a read is the sandbox. The keychain search list is compared before and after: unchanged.
5. **Plants hostile parent state** before spawning: `BITSOV_TOKEN=canary-token-…`, `KONSENSUS_API_TOKEN`, `HTTPS_PROXY`, `ALL_PROXY`, plus stray descriptors (fd 7 → `nodedata/canary.txt`, fd 8 → the pairing challenge).
6. **Baseline:** runs the probe **unconfined** through the same launcher (`j0spawn --no-sandbox`). This shows every attack actually works without the sandbox, so a "denied" result later is meaningful. The canaries are then recreated.
7. **Leak control:** runs the probe with raw `sandbox-exec` and **without** the launcher's scrub. This shows the fd and environment checks do detect leaks.
8. **Confined runs:** the probe runs confined as `ROLE=assistant` and again as `ROLE=llm`. A sha256 manifest of every protected path is taken before and after each run.
9. **Real-tool attacks:** `security find-generic-password` / `dump-keychain` against the throwaway keychain, and `lldb --batch -p <broker>`. Both are run unconfined (baseline) and confined under both roles. For lldb, the profile is *widened* just enough for lldb and debugserver themselves to load from `/Library/Developer/CommandLineTools`, so the only thing tested is the attach.
10. **Cleanup** (in a trap): stops the dummy broker (a pid it started), runs `security delete-keychain <exact path>`, and deletes the temp dir.

`scripts/spike/run-model-load.sh` does the same for the model (section 4).

Re-run:

```bash
scripts/spike/run-isolation-tests.sh                        # exit 0 iff all PASS
scripts/spike/run-isolation-tests.sh --evidence-dir DIR     # also copy raw logs
scripts/spike/run-model-load.sh --model /path/to/model.gguf [--llama-bin DIR]
```

Raw evidence from the recorded run is in `docs/spike/evidence/isolation/`: `summary.txt`, `probe-*.txt`, `keychain.txt`, `debugger.txt`, `manifest-*`, `broker-log.txt`. The model evidence is in `docs/spike/evidence/model/`.

---

## 3. Test matrix — isolation

Recorded run: **`PASS=412 FAIL=0`**. It covers both roles; each role runs the probe's full set. Some probe ids are prefixed `pos.` even when the expected result for that role is DENIED; the runner's rule for each id is given in the "Required" column. "Baseline" is the same attempt made unconfined, and "OK" there means the attack really works without the sandbox. 322 of the confined denials have a baseline that succeeded.

### Reads (Phase 1 "Isolation — reads")

| Control | Probe ids | Required | Assistant | LLM | Baseline | Evidence |
|---|---|---|---|---|---|---|
| Node port unreachable (fake node on a random loopback port) | `net.node_tcp_127.0.0.1` | DENIED | PASS `EPERM` | PASS `EPERM` | OK (got `pong node-tcp`) | `probe-*.txt` |
| No UDP to loopback, no TCP listen, no egress | `net.udp_loopback_send`, `net.tcp_listen_loopback`, `net.egress_tcp_testnet` (192.0.2.1, TEST-NET) | DENIED | PASS `EPERM` ×3 | PASS `EPERM` ×3 | OK / OK / timeout | Egress fails with `EPERM` inside the sandbox, not a timeout. No real egress was attempted. |
| Fake `control.sock` cannot be connected | `net.control_sock` | DENIED | PASS `EPERM` | PASS `EPERM` | OK | |
| Node data dir unreadable | `read.nodedata_{file,wallet}.{stat,open}`, `read.nodedata_dir.{stat,listdir}` | DENIED | PASS ×6 | PASS ×6 | OK | Even `stat` is denied, so existence, size and timestamps are hidden too. |
| Pairing challenge files unreadable | `read.pairing_{challenge,nonce}.{stat,open}`, `read.pairing_dir.*` | DENIED | PASS ×6 | PASS ×6 | OK | |
| Host code, host config and sibling files unreadable | `read.{hostcode,hostconfig,sibling}_file.*` | DENIED | PASS ×6 | PASS ×6 | OK | |
| Keychain file unreadable | `read.keychain_file.{stat,open}` | DENIED | PASS | PASS | OK (read the `kych` header) | |
| Keychain item unreadable with the real tool | `keychain.item_unreadable` | DENIED | PASS | PASS | **OK: the unconfined `security` printed the secret** | `keychain.txt`. Confined: `SecKeychainSearchCopyNext: The specified item could not be found in the keychain.` (exit 44) |
| Keychain daemons unreachable | `mach.com.apple.SecurityServer`, `mach.com.apple.securityd.xpc` (+ `securityd`, `secd`, which are absent on 26.x) | DENIED | PASS | PASS | reachable | `bootstrap_look_up` fails with 1100 (permission denied). |
| Debugger attach to the broker fails | `proc.task_for_pid`, `proc.ptrace_attach`, `debugger.lldb_attach` | DENIED | PASS (`KERN_FAILURE`, `EPERM`) | PASS | **task_for_pid OK; lldb attached and detached** | `debugger.txt`. An earlier run, before the process-info deny, showed confined lldb failing with `attach failed (Not allowed to attach to process…)`. With the final profile the broker is invisible (`no such process`). |
| No process inspection | `proc.task_name_for_pid`, `proc.pidinfo`, `proc.pidpath`, `proc.listallpids`, `proc.sysctl_kern_proc_pid` | DENIED | PASS | PASS | OK | Needed an explicit `(deny process-info*)` plus a self-only allow, and a `kern.proc.` sysctl deny. Under `(deny default)` alone, `proc_pidpath` and `proc_listallpids` of other processes **succeeded** (see §6). |
| Signals to the broker fail | `sig.kill0`, `sig.SIGUSR1`, `sig.SIGSTOP`, `sig.SIGTERM`, `sig.SIGKILL`, `sig.no_delivery`, `sig.broker_alive` | DENIED | PASS | PASS | kill0 and SIGUSR1 delivered (broker counted 1) | The broker's SIGUSR1 counter did not change during the confined runs, and the broker survived STOP, TERM and KILL. Destructive signals had no baseline run, by design. |
| OS automation, TCC, pasteboard, window server, LaunchServices unreachable | `mach.com.apple.coreservices.appleevents`, `tccd`, `tccd.system`, `pasteboard.1`, `windowserver.active`, `CoreServices.coreservicesd`, `lsd.mapdb`, `distributed_notifications@Uv3` | DENIED | PASS ×8 | PASS ×8 | reachable | No Apple Events were sent; only the lookup was attempted. |
| Environment scrubbed, no token | `env.no_sensitive_vars`; control `env.leak_control_detects` | CLEAN | PASS: `names=[PATH,HOME,TMPDIR,LANG]` | PASS | The leak control **saw** `BITSOV_TOKEN` and the proxy variables. | The planted `canary-token-*` never reached the child. |
| Only the bootstrap pipe inherited | `fd.only_stdio_and_bootstrap_pipe`; control `fd.leak_control_detects` | fds = {0,1,2,3}, fd 3 = pipe | PASS | PASS | The leak control **saw** stray fd 7 and fd 8. | fd 0 is `/dev/null`; fds 1 and 2 are the launcher's log sink. |
| Children stay confined | `exec.child_inherits_sandbox` (confined `/bin/cat nodedata/canary.txt`) | DENIED | PASS | PASS | OK | The sandbox is inherited across `posix_spawn`. |
| **Positive:** broker IPC socket works | `pos.broker_ipc_sock` | OK | PASS (`pong broker.sock`) | n/a | | |
| **Positive:** LLM socket works (assistant → LLM) | `pos.llm_sock` | OK | PASS (`pong llm.sock`) | n/a | | |
| LLM has no outbound socket at all | `llm_sock_outbound`, `broker_ipc_sock_outbound` | DENIED | n/a | PASS | | Per §3.1, the LLM runtime has only the socket to its user. |
| **Positive (LLM):** serves exactly its own socket | `net.listen_unix` in `LISTEN_DIR` | OK for llm, DENIED for assistant | PASS (DENIED) | PASS (OK) | | |
| **Positive:** bootstrap pipe carries the per-spawn secret | `pos.bootstrap_pipe_fd3` | OK | PASS | PASS | | |

### Writes (Phase 1 "Isolation — writes")

There are 16 operations per target directory. Each is attempted against a disposable `canary.txt` or a new name in the target:

- `create`, `mkdir`, `write` (append)
- `truncate`, `open_trunc`
- `chmod`, `utimes`, `setxattr`
- `rename_in_place`, `rename_out_to_scratch`, `rename_in_from_scratch`
- `symlink_create_in_target`, `symlink_escape_write` (a link made in scratch pointing at the canary, then written through)
- `hardlink_create_in_target`, `hardlink_escape` (hard-link the canary *into* scratch, then write)
- `unlink`

| Target | Assistant (16 ops) | LLM (16 ops) | Baseline |
|---|---|---|---|
| host code (`hostcode/`) | 16/16 DENIED `EPERM` | 16/16 DENIED | 16/16 OK |
| host config (`hostconfig/`) | 16/16 DENIED | 16/16 DENIED | 16/16 OK |
| node data (`nodedata/`) | 16/16 DENIED | 16/16 DENIED | 16/16 OK |
| pairing (`nodedata/pairing/`) | 16/16 DENIED | 16/16 DENIED | 16/16 OK |
| sibling dir (`sibling-child/`) | 16/16 DENIED | 16/16 DENIED | 16/16 OK |
| the other child's scratch | 16/16 DENIED | 16/16 DENIED | 16/16 OK |
| weights (`weights/`) | 16/16 DENIED | 16/16 DENIED | 16/16 OK |
| parent / canary root | 16/16 DENIED | 16/16 DENIED | 16/16 OK |
| **Positive:** own scratch | **16/16 OK** | **16/16 OK** | — |

The runner also checks two things independently of the probe's own reports:

- **`canary.integrity`:** the sha256 of all 16 protected paths is byte-identical before and after each confined run, with no new files. PASS for both roles.
- **`probe.completed`:** both probes ran to the end with 144 write attempts each, so a crashed probe cannot pass by omission.

---

## 4. Model load under confinement

Model: Lane 2's `Qwen/Qwen3-4B-GGUF` `Qwen3-4B-Q4_K_M.gguf` (revision `bc640142`, 2,497,280,256 bytes, sha256 `7485fe6f…34fdf5`). It stayed in `~/Desktop/seat-drafts/models/`, was never copied, and is never in git. Runtime: llama.cpp `d81aef1`, Release build with `GGML_METAL=ON` (Lane 2's build). Runner: `scripts/spike/run-model-load.sh`, recorded result **`PASS=5 FAIL=0`**. Evidence is in `docs/spike/evidence/model/`.

| # | Check | Result | Evidence |
|---|---|---|---|
| M1 | `llama-simple -ngl 99 -n 48` **confined** (`ROLE=llm`, weights dir read-only, scratch the only writable place) | **PASS.** `ggml_metal_device_init: GPU name: MTL0 (Apple M4 Max)`, `using device MTL0 (Apple M4 Max)`, **`offloaded 37/37 layers to GPU`**, load time 374 ms. Output: *"The three primary colors of light are red, green, and blue. When these colors are combined in equal parts, they produce white light. …"*. The text is identical to the unconfined baseline (M0). | `M1-confined.txt`, `M0-unconfined.txt` |
| M2 | Weights immutable from the confined LLM: `touch` a new file in the weights dir; open the `.gguf` for append (zero bytes); hard-link the `.gguf` into its own scratch | **PASS.** All three fail with `Operation not permitted`. | `M2-weights-write.txt` |
| M3 | `llama-server -ngl 99 --host <LISTEN_DIR>/llm.sock` **confined** (`ROLE=llm`). A **confined** assistant (`ROLE=assistant`, `j0uclient`) calls `GET /health`, then `POST /completion` over the socket. | **PASS.** Server log: `listening on unix:///private/tmp/j0-canary-model-…/ipc/llm/llm.sock`. `lsof -iTCP` on the server shows no TCP listener. The assistant received `"content":" red, green, and blue. …"` | `M3-server.txt`, `M3-assistant.txt` |
| M4 | Model bytes unchanged | **PASS.** sha256 is identical before and after, and matches Lane 2's marker. | `summary.txt`, `env.txt` |
| M5 | Negative control: the same llama.cpp under `ROLE=assistant` (no IOKit or Metal rules) | **PASS.** `ROLE=llm` lists `MTL0: Apple M4 Max`; `ROLE=assistant` lists no Metal device. The GPU allowance is exactly what enables Metal. | `M5-*.txt` |

**Metal and GPU work under the sandbox**, with full offload. The only profile allowances Metal needs are:

- `iokit-open` on `AGXDeviceUserClient`, `AGXSharedUserClient` and `IOSurfaceRootUserClient`
- `iokit-get-properties`
- the mach services `com.apple.MTLCompilerService` and `com.apple.gpumemd.source`

Metal needed no file writes outside scratch.

**Performance: not measured.** The single 48-token runs gave 73.9 t/s confined against 96.4 t/s unconfined, but this is **UNVERIFIED as sandbox overhead**. Lane 2's model evaluation was using the same GPU concurrently. An interleaved `llama-bench` (pp256 / tg128) taken during that contention gave about 465 / 14–15 t/s unconfined and about 740 (pp32) / 14 t/s confined, which is inconclusive. Phase 1 must measure latency and memory on an idle machine, as ROADMAP Phase 1 "Answers" already requires.

**Notes from the model runs:**

- `/usr/bin/curl` cannot be used as a confined client. Apple's LibreSSL reads `/private/etc/ssl/openssl.cnf` at start-up, even for plain HTTP, and ignores `OPENSSL_CONF`. The profile was **not** widened for it; a 60-line unix-socket HTTP client (`j0uclient.c`) stands in for the assistant.
- llama.cpp logs `ggml_backend_load_best: current_path() failure: Operation not permitted`, because the inherited working directory (the worktree) is unreadable. This is harmless, since the backends are linked in. Phase 1's launcher should `chdir` into the child's scratch.

---

## 5. The profile, in one screen

`scripts/spike/j0-confined-child.sb`:

- `(deny default)`, then `(import "dyld-support.sb")` (Apple-maintained dyld bootstrap).
- **Exec:** only `EXEC_DIR`, `LIB_DIR`, `/bin` and `/usr/bin`, and every descendant inherits the sandbox.
- **Process:** `(deny process-info*)` then allow for `self` only. Signals to `self` only. `mach-priv-task-port` and `mach-task-name` denied. sysctl reads allowed except `kern.proc.*`.
- **Read:** OS runtime (`/System`, `/usr/lib`, `/usr/share`, dyld, timezone, a few `/dev` nodes), plus the child's own `EXEC_DIR`, `LIB_DIR`, `WEIGHTS`, `SCRATCH` and `IPC_DIR`. `stat` is allowed only on the ancestors of those paths.
- **Write:** `SCRATCH` only (plus `/dev/null`). With `ROLE=llm`, also `LISTEN_DIR`, because the socket node must be created there.
- **Network:** outbound only to unix sockets under `IPC_DIR`. No TCP or UDP at all, loopback included. With `ROLE=llm`: bind and inbound only on unix sockets under `LISTEN_DIR`.
- **Mach:** **none** for the assistant. With `ROLE=llm`: `com.apple.MTLCompilerService` and `com.apple.gpumemd.source` only, plus `iokit-open` for `AGXDeviceUserClient`, `AGXSharedUserClient` and `IOSurfaceRootUserClient` (Metal).

The launcher (`j0spawn.c`) supplies what a profile cannot: the bootstrap pipe on fd 3, closing every other fd, a fixed 4-variable environment, and signal forwarding so that stopping the launcher stops the child.

---

## 6. Findings and residual risks

1. **`(deny default)` does not cover process-info.** Without the explicit `(deny process-info*)`, a confined child could still call `proc_pidpath`, `proc_pidinfo` and `proc_listallpids` on other processes, and `sysctl kern.proc.*`. This was measured, not assumed. It is fixed in the profile and covered by `proc.*` tests. **Phase 1 must keep these tests**, because this behaviour is undocumented.
2. **Deprecated, private interface.** `sandbox_init_with_parameters` and SBPL carry no stability promise. Mitigations: fail closed; run the suite in CI and as a startup self-test on each macOS version; App Sandbox fallback (§1).
3. **The broker is trusted.** The broker chooses the profile parameters and the environment. A compromised broker is out of scope, as it is in THREAT-MODEL.md.
4. **Same-user malware is out of scope**, as stated in ARCHITECTURE §3.1. The sandbox confines the child; it does not protect the node from other unconfined processes run by the same user.
5. **Readable OS areas.** `/System`, `/usr/lib` and `/usr/share` are readable. They hold no user data, but a child can fingerprint the OS version.
6. **Working directory.** The launcher does not `chdir` yet, so the child inherits a cwd it cannot read (harmless, but noisy). Phase 1 should `chdir` into scratch before exec.
7. **stdio.** fds 0, 1 and 2 are inherited: `/dev/null` and the launcher's log sink. Phase 1 should make fds 1 and 2 pipes owned by the broker, with size limits, rather than files.
8. **The Metal allowance is a larger attack surface** (the GPU driver user clients and `MTLCompilerService`) for the LLM role only. A GPU driver exploit would escape any userspace sandbox. That is accepted as residual; CPU-only (`-ngl 0`, dropping the IOKit and Metal rules) is available where it is not acceptable.
9. **Resource limits (T21) are not part of this spike.** Memory, CPU and disk quotas on scratch are separate work (`setrlimit`, launchd, or APFS quotas).
10. **Only the assistant and LLM roles were tested.** Speech, TTS, embedding, plugin and parser children need their own parameter sets, run through this same suite.
11. **Performance overhead of the sandbox is not measured** (GPU contention during the spike; see §4).
12. **Not covered here:** the assistant-window command boundary (§3.1a, Tauri ACL) and the renderer tests are separate Phase 0.5 items and were not part of this lane.

---

## 7. Files

| Path | What |
|---|---|
| `scripts/spike/j0-confined-child.sb` | The SBPL profile (assistant and llm roles) |
| `scripts/spike/j0spawn.c` | Launcher: bootstrap pipe, fd close, env scrub, `sandbox_init_with_parameters`, exec |
| `scripts/spike/j0probe.c` | Attacker and probe run inside the child |
| `scripts/spike/dummy_broker.c` | Fake node port, `control.sock`, LLM and broker sockets, SIGUSR1 counter |
| `scripts/spike/run-isolation-tests.sh` | Re-runnable isolation suite (canaries, keychain, baseline, confined, evaluation, cleanup) |
| `scripts/spike/j0uclient.c` | Minimal HTTP-over-unix-socket client (the assistant stand-in in M3) |
| `scripts/spike/run-model-load.sh` | Confined model load, weights immutability, confined server and assistant over a unix socket, GPU negative control |
| `docs/spike/evidence/` | Raw logs of the recorded runs |
| `.gitignore` | `*.gguf`, `*.safetensors`: weights never enter git |
