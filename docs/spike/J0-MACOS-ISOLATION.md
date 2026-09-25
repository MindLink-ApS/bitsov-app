# J0 Lane 1 — Phase 0.5 macOS isolation spike (mock only)

| | |
|---|---|
| Date | 2026-09-25 (fix pass after Codex FAIL of `8c64b3bf`) |
| Branch / base | `spike/j0-macos-isolation` from `origin/main` `0190baa` |
| Host | Apple M4 Max, macOS 26.6.2 (25G83), SIP enabled, Developer Mode off, user in `_developer`, application firewall off |
| Scope | ARCHITECTURE §3.1 isolation contract, ROADMAP Phase 1 "Isolation — reads" and "Isolation — writes", for the **assistant** and **LLM runtime** children |
| Rules kept | Mock only. No node, wallet, seed, relay, cloud, sidecar or Tauri run. Port 3141 never bound or used. All canaries lived under fresh `mktemp -d /tmp/j0-canary-*` dirs, which were deleted afterwards. The throwaway keychain was created inside that dir, used and deleted by its exact path. The login keychain, the search list and the default keychain were never touched; their hashes before and after are in the evidence. No internet egress. No GUI automation. |

**Recorded results (this pass):**

| Suite | PASS | WEAK / INCONCLUSIVE | FAIL | INFO (not required) |
|---|---|---|---|---|
| Isolation (`run-isolation-tests.sh`) | **477** | **0** | **0** | 4 |
| Model load (`run-model-load.sh`) | **5** | **0** | **0** | — |

**VERDICT: ALL REQUIRED CONTROLS ENFORCEABLE ON macOS**

Every required control is PASS under the stricter scoring introduced in this pass:

- a sandbox-specific denial;
- a successful same-operation unconfined baseline;
- presence in the results (a missing ID is a FAIL).

No required control is only WEAK/INCONCLUSIVE. The 4 INFO lines are the legacy mach names `com.apple.securityd` and `com.apple.secd`, for both roles. They do not exist on macOS 26 (the baseline gets `1102 unknown service`), and their live replacements are required controls with baselines (§3). The verdict covers the assistant and LLM-runtime children on this machine and OS version. See §6 for the residual risks.

---

## 0. Changes since `8c64b3bf` (Codex FAIL)

| # | Codex finding | Fix | Evidence |
|---|---|---|---|
| P1-1 | `j0spawn` closed fds only below `min(rlim_cur, 65536)`, and `j0probe` only inventoried fds below 4096. | macOS has no `closefrom(2)`. The launcher now **enumerates its real descriptor table** with `proc_pidinfo(PROC_PIDLISTFDS)`, closes everything above 3, re-enumerates, and **refuses to exec** if anything is left (fail closed). No rlimit is involved. The probe now reports two independent inventories: the kernel table (`PROC_PIDLISTFDS`) and an `fcntl(F_GETFD)` scan of every number below `kern.maxfilesperproc` (138240). For every fd above 3 it classifies the content (host-private / canary / other) without printing it. New helper `j0fdplant` plays the careless parent: host-private pipes at **fd 5000 and fd 70000**, then the soft `RLIMIT_NOFILE` is **lowered to 256**, then exec. Every probe run (baseline, both confined roles, both leak controls) goes through it. | `fd.legacy_launcher_leaks`: the 8c64b3bf loop, rebuilt with `-DJ0_LEGACY_RLIMIT_CLOSE` and run confined, leaks fds 5000 and 70000, both **readable host-private pipes**, so the bug was real. `fd.leak_control_detects`: with no launcher, 7, 8, 5000 and 70000 are all visible. With the fixed launcher, both roles show exactly `0,1,2,3` in both inventories. |
| P1-2 | `412/0` counted "baseline also unreachable" and "no baseline" as PASS. | The runner now has three scores: **PASS / WEAK (inconclusive) / FAIL**. WEAK is never counted as PASS and makes the runner exit non-zero. Every required ID is enumerated by the runner (reads × targets, writes × 16 ops × targets, net, mach, proc, sig, exec). An ID missing from the probe output is a **FAIL**. The 14 formerly vacuous controls now have real positive baselines: the destructive signals and ptrace, non-loopback egress, `::1`, and the keychain daemons (next row). The headline, the report and the verdict give all three counts. | `summary.txt`. 413 denials are paired with a successful baseline. The remaining PASS lines are positive controls, the victim, env, fd, integrity and log checks, and the real-tool keychain and debugger checks, each with its own baseline. |
| P1-2 detail | `sig.SIGSTOP/TERM/KILL` and `proc.ptrace_attach` had no baseline (6 + 2). | The destructive signals and `ptrace(PT_ATTACHEXC)` go to **disposable victim processes** (the `get-task-allow` dummy binary in `--victim` mode), fresh for each run, in both modes. The runner checks each victim's fate independently with `ps` stat and the `wait` status. | `victims.txt`. Baseline: stop victim `T`, TERM victim `exit=143`, KILL victim `exit=137`, ptrace OK. Confined: all four still running (`S`). |
| P1-2 detail | `net.egress_tcp_testnet` baseline was a timeout (2). | Replaced by `net.egress_tcp_nonloopback`: a TCP connect to a dummy listener on **this host's own LAN IPv4**, which answers only this host itself. There is no internet traffic, and the 192.0.2.1 attempt is gone. | Baseline receives `pong egress`. Confined gets `EPERM`. |
| P1-2 detail | `mach.com.apple.securityd` and `secd` were absent services (4). | The live keychain daemons are required instead: `com.apple.securityd.general` (the user-domain secd), `com.apple.security.octagon` and `com.apple.ctkd.token-client`, next to `SecurityServer` and `securityd.xpc`. The absent legacy names stay as INFO only. | Every required mach name: baseline reachable, confined `KR1100` (`BOOTSTRAP_NOT_PRIVILEGED`). |
| P1-2 detail | `net.node_tcp_::1` was vacuous. | The dummy broker now also listens on `[::1]:P`. | Now a required control. Baseline `pong`, confined `EPERM`. |
| P1 #2 (model) | `run-model-load.sh` could delete a pre-existing `j0-created-by-confined-llm`. | M2 uses fresh random names (`mktemp -u` → `.j0-m2-{baseline,confined}-XXXXXXXXXXXX`). It **refuses to run** if either name exists, and removes only that exact path, only if it is a regular file (proved absent before the run). | `M2-weights-write.txt`. The model dir holds only its original entries after the run. |
| P2 | Evidence had fd-3 secret fragments, the full keychain canary, env names and `/Users/<name>` paths. | The probe logs the bootstrap secret only as **length + sha256**. The launcher (`--report`) prints the sha256 of what it sent, and the runner requires equality, which proves the child got the exact secret. Keychain output is compared in memory; the log gets only `secret_in_output=yes/no`. The leak control runs under `env -i`, so no operator variable names reach the log. Both runners copy evidence through a redactor (`$HOME` → `~`, `/Users/<x>` → `/Users/<user>`, user name → `<user>`). New control `evidence.no_secrets` greps all raw logs for the keychain secret, `J0-BOOTSTRAP-<hex>`, `J0-HOSTPRIVATE-<hex>` and the planted token value. | `evidence.no_secrets` PASS. A post-copy check fails the run if `$HOME` survives redaction. |
| P2 | `j0uclient` overread when the request exceeded 8192 bytes. | It rejects `snprintf` results that are negative or `>= sizeof req` (exit 2), writes in a loop, treats read errors as failure, and requires an `HTTP/1.x 2xx` status line read to EOF. | — |
| P2 | Evaluators accepted any failure. | Every errno-based denial must be **`EPERM`/`EACCES`**; any other errno is a FAIL. Mach lookups must be `KR1100`; `task_for_pid`/`task_name_for_pid` must be `KR5` with an OK baseline. Each probe run is cross-checked against the **kernel's sandbox log** (`log show`, `sender == "Sandbox"`, filtered to this run's confined pids). The log must show `deny` records of every class the probe tests: file-read, file-write, network-outbound, network-bind, mach-lookup, process-info, signal, sysctl-read and process-exec (`sandbox_log.corroborates`). Real-tool checks need their own kernel record: `security(<pid>) deny file-read-metadata <keychain dir>`, and `lldb(<pid>) deny process-info-pidinfo others [dummy_broker(<pid>)]`. The debugger check also needs a baseline attach and a literal `error: attach failed`, and a missing baseline is WEAK. The model runner requires M0 success (M1's baseline), the M2 baselines plus `Operation not permitted` plus a kernel deny, the M3 **client** exit status plus a **successful** `lsof` that shows the unix socket and no IPv4/IPv6, M4 64-hex hashes that match Lane 2's marker, and M5 exit statuses plus an unconfined `--list-devices` control. | `sandbox-log.txt` (isolation and model). |
| P2 #7 | `kern.procargs`/`kern.procargs2` were not excluded. Exec of `/bin` and `/usr/bin` was allowed. | `(deny sysctl-read (sysctl-name-prefix "kern.procargs"))`, tested by `proc.sysctl_kern_procargs{,2}` against the broker: baseline OK, confined EPERM. **Exec is narrowed** to `EXEC_DIR`/`LIB_DIR`: new controls `exec.system_shell` (`/bin/sh`) and `exec.system_bin_cat` are denied. The test-only parameter `SYSTEM_EXEC=yes` re-allows `/bin` and `/usr/bin` exec and read, so the suite can still run real attack tools (`security`, `touch`, `sh`, `ln`) confined. That only makes the attacker stronger. `exec.child_inherits_sandbox` now re-execs the probe itself (inside `EXEC_DIR`) and reports the grandchild's own errno. | §3 |
| P2 (A) | The profile was broader than its summary. | (a) `/System/Volumes/Data` is **explicitly denied**, and new read and write targets go through the Data-volume firmlink path (`/System/Volumes/Data/private/tmp/...`): baseline OK, confined EPERM. (b) `/dev/dtracehelper` write and ioctl were **removed**; the model still loads with full Metal offload. (c) The LLM role no longer has any `IPC_DIR` outbound rule; outbound unix is inside the assistant-only branch. (d) The LLM's listen allowance is now **one literal socket path** (`LISTEN_SOCK`), not a directory. New control `net.listen_unix_other`: a second socket in the same dir is denied, baseline OK. (e) Tried and **reverted**: denying `file-read-data` on literal `/` (imported from `dyld-support.sb`). dyld aborts before `main` (every confined process exits 134). Kept as a residual (§6). | §5, §6 |
| (C) | Launcher hygiene. | `fcntl(F_SETFD)` failure → exit 125. `setsid()`: no controlling terminal, and signals forward to the whole process group. Optional `--chdir` (the runners chdir into scratch, which removes llama.cpp's `current_path()` error). Bootstrap write loop with EINTR handling. `waitpid` errors → 125, never a false success. The random bytes and the secret are wiped with `memset_s` in the parent after writing, and in the child before exec. SIGALRM is forwarded, so the runner's timeout reaches the child. | — |
| (C) | `dummy_broker` rejected 3141 only after bind. | The port is drawn from 20000–60999, checked against 3141 **before** `bind`, with a retry on collision. | — |
| (C) | `canary.integrity` checked only names and content. | The manifest now records content sha256, mode, mtime, size and xattr names for every protected file and dir, plus the canary root's top-level entry names. | `manifest-*.txt`, empty `manifest-*.diff`. |
| (D) | Script safety. | `mktemp` and canonicalization failures are fatal. `rm -rf` runs only after a strict prefix check (`/private/tmp/j0-canary-????????`). INT/TERM/HUP → exit → cleanup trap. Setup steps (`build`, `codesign`, `create-keychain`, `add-generic-password`, broker start) fail closed. A search-list or default-keychain change is now a **FAIL**; nothing is ever written to them to "restore" state. Canary resets use `-mindepth 1`: a trial run of this pass showed that without it `find "$ROOT" -maxdepth 1 -name 'j0-*'` matches the temp root itself. It only ever deleted its own temp dir. | `keychain-searchlist.txt` |

---

## 1. Mechanism choice

**Chosen: Seatbelt (the kernel `Sandbox.kext` MAC policy) with a custom SBPL profile, applied by the broker to each child just before `exec`, using `sandbox_init_with_parameters()`.**

In the spike, `scripts/spike/j0spawn.c` does the launching. `sandbox-exec -f` applies the same profile and is used as a leak control. Phase 1 would reproduce `j0spawn` in about 100 lines of Rust in the bitsov-app broker, in the child side of `fork`, before `execve`:

1. Put the per-spawn secret in the bootstrap pipe on fd 3.
2. Close every other descriptor by enumerating `PROC_PIDLISTFDS`, then verify, and fail closed.
3. Replace the environment with a fixed minimal one.
4. Call `setsid` and `chdir` into scratch.
5. Apply the profile.
6. Call `execve`.

| Option | Enforceable for this contract? | Signing / packaging | Status | Decision |
|---|---|---|---|---|
| **Custom SBPL profile via `sandbox_init_with_parameters` (or `sandbox-exec`)** | **Yes: every control in §3.1 was enforced and tested (below).** Rules are per path, per socket path, per mach service, per IOKit class and per process target. The sandbox is inherited by every descendant and cannot be lifted from inside. | None. It works on unsigned or ad-hoc binaries such as the llama.cpp build. It does not interact with the app's own signing or notarization. | `sandbox-exec(1)` and `sandbox_init(3)` are documented as **DEPRECATED** (the man page points to App Sandbox). `sandbox_init_with_parameters` is exported by `libsystem_sandbox` but is not in the public header. It still works on macOS 26.6.2, and macOS itself ships and relies on it (`/System/Library/Sandbox/Profiles/*.sb`, and `dyld-support.sb`, which this profile imports). Chromium, Firefox, Bazel, Nix and several coding-agent CLIs confine child processes this way. | **Chosen.** Only this option can express the contract: one writable scratch dir, the weights read-only, exactly one unix socket, no loopback TCP, no mach services, no signals or inspection. |
| App Sandbox (entitlements) on an ad-hoc-signed helper | **Partly.** There is no way to say "allow this one unix socket but no loopback TCP": `network.client` is all-or-nothing, and unix-socket access outside the container needs temporary-exception entitlements. File access to the weights and socket paths needs `temporary-exception.files.absolute-path.*`. A container is forced into `~/Library/Containers/<id>`. Mach lookups cannot be denied more tightly than the App Sandbox baseline. Signals and process-info to same-user processes are governed by the baseline, not by a profile. | Each helper binary needs a bundle identifier and an entitlements plist, and must be code-signed. Distribution needs Developer ID and notarization of every helper, including a rebuilt llama.cpp. | Supported, not deprecated. | **Rejected as primary.** It remains the fallback if Apple ever removes custom profiles. (Not executed in this spike: it would create a persistent `~/Library/Containers` entry.) |
| Separate macOS user per child | Removes same-user signals and debugging. It does **not** stop loopback TCP to the node port, connects to `control.sock` when permissions allow, or mach lookups. | Needs an admin-created user and a privileged helper. | Supported. | Rejected: it needs root and does not cover network or IPC. Could be layered on later. |
| Virtualization.framework VM | Strong, but no Metal for llama.cpp inside the guest today. | Virtualization entitlement (signed). | Supported. | Rejected for the LLM (no Metal). Over-scoped for the assistant. |

**What Phase 1 would ship on macOS:** `scripts/spike/j0-confined-child.sb`, embedded as a resource and **without** `SYSTEM_EXEC`. The broker's Rust spawn path applies it to the assistant (`ROLE=assistant`) and to llama.cpp (`ROLE=llm`) with per-spawn parameters. The broker **fails closed**: if `sandbox_init_with_parameters` fails, or descriptors cannot be closed, the child is never exec'd. A startup self-test should run a reduced version of `run-isolation-tests.sh` and refuse to start the assistant if any control is not in force.

**Deprecation risk:** Apple could remove `sandbox_init*` or change SBPL. Mitigations:

- Import Apple's own `dyld-support.sb`. Without it, dyld aborts on macOS 26 because it cannot map the shared cache from `/System/Volumes/Preboot/Cryptexes/OS`.
- Run this suite in CI on each supported macOS version.
- Fail closed.
- Keep App Sandbox as the fallback plan.

---

## 2. How the tests work

`scripts/spike/run-isolation-tests.sh` is self-contained and re-runnable. It exits 0 only if FAIL = 0 **and** WEAK = 0. Each run:

1. **Builds** `j0spawn`, `j0spawn-legacy` (the 8c64b3bf fd loop, for the regression control only), `j0probe`, `dummy_broker` and `j0fdplant` into a fresh `/tmp/j0-canary-XXXXXXXX/bin`. `dummy_broker` is ad-hoc signed with `get-task-allow`, so the *unconfined* debugger and ptrace baselines are meaningful.
2. **Creates disposable canaries** with random contents in `hostcode/`, `hostconfig/`, `nodedata/` (plus `pairing/`), `nodedata-dv/` (only ever addressed through `/System/Volumes/Data/...`), `sibling-child/`, `weights/`, the other child's scratch, and the canary root.
3. **Starts `dummy_broker`**, which listens on:
   - TCP `127.0.0.1:P` and `[::1]:P`, where P is random and checked ≠ 3141 before bind;
   - UDP `127.0.0.1:P`, counting received datagrams;
   - TCP `<LAN IPv4>:Q`, the egress target, which only answers this host;
   - `nodedata/control.sock`;
   - `ipc/llm.sock` and `ipc/broker.sock`.

   It counts SIGUSR1s.
4. **Creates the throwaway keychain** inside the temp dir, with a random password, and adds a generic-password item with `-A` (no prompt for any app), so only the sandbox can stop a read. It records hashes of the user search list and the default keychain before and after.
5. **Plants hostile parent state:**
   - token and proxy environment variables;
   - stray fds 7 and 8 (node-data files);
   - via `j0fdplant`, host-private pipes at fds 5000 and 70000 with the soft fd limit lowered to 256.
6. **Baseline:** runs the probe **unconfined** through the same launcher (`--no-sandbox`) against fresh victims. Every attack must work here.
7. **Leak controls:** runs the probe (a) under raw `sandbox-exec` with no launcher, and (b) through the 8c64b3bf launcher, confined. Both must *see* the planted fds and env.
8. **Confined runs** (`ROLE=assistant`, then `ROLE=llm`), each with fresh victims and a before/after manifest.
9. **Real-tool attacks:** `security find-generic-password` and `dump-keychain` against the throwaway keychain, and `lldb --batch -p <broker>`. Both are run unconfined (baseline) and confined under both roles.
10. **Kernel log:** collects `Sandbox` deny records for this run's confined pids. It waits until the last tool's pid appears, because the log lags by a few seconds.
11. **Evaluates** (below), copies redacted evidence, and cleans up in a trap:
    - the broker and victims (pids it started);
    - `security delete-keychain <exact path>`;
    - `rm -rf` of the prefix-checked temp dir.

**Scoring:**

| Score | Meaning |
|---|---|
| **PASS** | Confined attempt denied **with the sandbox's own error** (`EPERM`/`EACCES`, bootstrap `1100`, `KR5` for task ports) **and** the same operation succeeded in the baseline. Or: a positive control that works confined. |
| **WEAK / INCONCLUSIVE** | Denied as required, but no successful same-operation baseline or no kernel corroboration. **Not counted as PASS**; the runner exits non-zero. |
| **FAIL** | Allowed, denied with an unrelated errno, or **missing from the results**. |
| **INFO** | Recorded, not required. |

`scripts/spike/run-model-load.sh` does the same for the model (§4).

Re-run:

```bash
scripts/spike/run-isolation-tests.sh                        # exit 0 iff FAIL=0 and WEAK=0
scripts/spike/run-isolation-tests.sh --evidence-dir DIR     # also copy redacted raw logs
scripts/spike/run-model-load.sh --model /path/to/model.gguf [--llama-bin DIR] [--evidence-dir DIR]
```

Raw evidence (redacted) is in `docs/spike/evidence/isolation/` and `docs/spike/evidence/model/`.

---

## 3. Test matrix — isolation

Recorded run: **`PASS=477 WEAK=0 FAIL=0`** (4 INFO). Each role has 236 PASS lines, and there are 5 role-independent controls. "Baseline" is the same attempt made unconfined; "OK" means the attack really works without the sandbox. **413 confined denials are each paired with a successful baseline** of the same operation.

### Reads (Phase 1 "Isolation — reads")

| Control | Probe ids | Required | Assistant | LLM | Baseline |
|---|---|---|---|---|---|
| Node port unreachable (v4 and v6) | `net.node_tcp_127.0.0.1`, `net.node_tcp_::1` | EPERM | PASS | PASS | OK (`pong`) both |
| No UDP to loopback (send **and** receipt) | `net.udp_loopback_send`, `net.udp_no_receipt` | EPERM; 0 datagrams received | PASS | PASS | send OK; broker received 1 |
| No TCP listen | `net.tcp_listen_loopback` | EPERM | PASS | PASS | OK |
| No egress beyond loopback | `net.egress_tcp_nonloopback` (this host's LAN IPv4) | EPERM | PASS | PASS | OK (`pong egress`) |
| Fake `control.sock` cannot be connected | `net.control_sock` | EPERM | PASS | PASS | OK |
| Node data unreadable (`stat` too) | `read.nodedata_{file,wallet}.{stat,open}`, `read.nodedata_dir.{stat,listdir}` | EPERM | PASS ×6 | PASS ×6 | OK |
| … also via the Data-volume firmlink | `read.nodedata_via_datavol.{stat,open}` (`/System/Volumes/Data/private/tmp/...`) | EPERM | PASS ×2 | PASS ×2 | OK |
| Pairing challenge files unreadable | `read.pairing_{challenge,nonce}.*`, `read.pairing_dir.*` | EPERM | PASS ×6 | PASS ×6 | OK |
| Host code, host config, sibling unreadable | `read.{hostcode,hostconfig,sibling}_file.*` | EPERM | PASS ×6 | PASS ×6 | OK |
| Other users' homes invisible | `read.users_dir.{stat,listdir}` (`/Users`) | EPERM | PASS ×2 | PASS ×2 | OK |
| Keychain file unreadable | `read.keychain_file.{stat,open}` | EPERM | PASS ×2 | PASS ×2 | OK |
| Keychain item unreadable with the real tool | `keychain.item_unreadable` | no secret; kernel deny on the keychain dir | PASS | PASS | `find-generic-password` printed the secret (exit 0); `dump-keychain` listed `"svce"="j0-canary"` |
| Keychain daemons unreachable | `mach.com.apple.{SecurityServer,securityd.xpc,securityd.general,security.octagon,ctkd.token-client}` | `KR1100` | PASS ×5 | PASS ×5 | all reachable |
| Debugger attach fails (real tool) | `debugger.lldb_attach` | `error: attach failed` + kernel `process-info` deny | PASS | PASS | lldb attached and detached |
| Debugger primitives | `proc.task_for_pid`, `proc.task_name_for_pid` (`KR5`), `proc.ptrace_attach` (EPERM, on a victim) | denied | PASS ×3 | PASS ×3 | all OK |
| No process inspection | `proc.pidinfo`, `proc.pidpath`, `proc.listallpids`, `proc.sysctl_kern_proc_pid` | EPERM | PASS ×4 | PASS ×4 | OK |
| No argv/env of other processes | `proc.sysctl_kern_procargs2`, `proc.sysctl_kern_procargs` | EPERM | PASS ×2 | PASS ×2 | OK |
| Signals fail | `sig.kill0`, `sig.SIGUSR1` (broker); `sig.SIGSTOP`, `sig.SIGTERM`, `sig.SIGKILL` (victims) | EPERM | PASS ×5 | PASS ×5 | all OK |
| … independently observed | `sig.victims_unharmed`, `sig.no_delivery`, `sig.broker_alive` | victims running; USR1 count unchanged | PASS ×3 | PASS ×3 | stop→`T`, TERM→143, KILL→137; USR1 delivered 1 |
| OS automation, TCC, pasteboard, window server, LaunchServices, notifications | `mach.com.apple.{coreservices.appleevents,tccd,tccd.system,pasteboard.1,windowserver.active,CoreServices.coreservicesd,lsd.mapdb,distributed_notifications@Uv3}` | `KR1100` | PASS ×8 | PASS ×8 | all reachable |
| Environment scrubbed | `env.exact_minimal` | exactly `PATH,HOME,TMPDIR,LANG`, no planted value | PASS | PASS | leak control saw `BITSOV_TOKEN`, `HTTPS_PROXY` |
| Only the bootstrap pipe inherited | `fd.only_stdio_and_bootstrap_pipe` | kernel table and full scan = `0,1,2,3`, fd 3 a pipe | PASS | PASS | `fd.leak_control_detects` (no launcher: 7, 8, 5000, 70000 visible, high ones readable) and `fd.legacy_launcher_leaks` (8c64b3bf launcher: 5000, 70000 leak) |
| Bootstrap secret delivered exactly | `pos.bootstrap_pipe_fd3` | sha256(child's fd-3 bytes) = launcher's | PASS | PASS | — |
| Children stay confined | `exec.child_inherits_sandbox` (probe re-execs itself; grandchild reads node data) | EPERM | PASS | PASS | OK |
| No shell / system binaries | `exec.system_shell` (`/bin/sh`), `exec.system_bin_cat` | EPERM | PASS ×2 | PASS ×2 | OK |
| **Positive:** broker IPC and LLM sockets | `pos.broker_ipc_sock`, `pos.llm_sock` | OK | PASS ×2 | n/a | |
| LLM has no outbound socket | `pos.llm_sock`, `pos.broker_ipc_sock` as the LLM | EPERM | n/a | PASS ×2 | OK |
| **Positive (LLM):** serves its one socket | `net.listen_unix` at `LISTEN_SOCK` | OK for llm, EPERM for assistant | PASS (EPERM) | PASS (OK) | OK |
| … and nothing else | `net.listen_unix_other` (second path in the same dir / scratch) | EPERM | PASS | PASS | OK |
| Kernel agrees | `sandbox_log.corroborates` | a `Sandbox … deny` of each of 9 op classes for the probe's pid | PASS | PASS | — |

### Writes (Phase 1 "Isolation — writes")

There are 16 operations per target:

- `create`, `mkdir`, `write` (append)
- `truncate`, `open_trunc`
- `chmod`, `utimes`, `setxattr`
- `rename_in_place`, `rename_out_to_scratch`, `rename_in_from_scratch`
- `symlink_create_in_target`, `symlink_escape_write`
- `hardlink_create_in_target`, `hardlink_escape`
- `unlink`

| Target | Assistant | LLM | Baseline |
|---|---|---|---|
| host code, host config, node data, pairing, sibling, other child's scratch, weights, canary root | 8 × 16 = 128 PASS (EPERM) | 128 PASS | 16/16 OK each |
| node data via `/System/Volumes/Data/...` | 16 PASS | 16 PASS | 16/16 OK |
| **Positive:** own scratch | **16/16 OK** | **16/16 OK** | — |

`canary.integrity` (both roles) independently checks that every protected path has unchanged content, mode, mtime, size and xattr names, and that no new entries appeared in the canary root. `probe.completed` checks that both the confined and the baseline probe finished. A crashed probe would also turn every unreported ID into a FAIL.

---

## 4. Model load under confinement

Model: Lane 2's `Qwen/Qwen3-4B-GGUF` `Qwen3-4B-Q4_K_M.gguf` (revision `bc640142`, 2,497,280,256 bytes, sha256 `7485fe6f…34fdf5`). It stayed in `~/Desktop/seat-drafts/models/` and is never in git. Runtime: llama.cpp `d81aef1`, Release, `GGML_METAL=ON` (Lane 2's build). Recorded result **`PASS=5 WEAK=0 FAIL=0`**.

| # | Check | Result | Evidence |
|---|---|---|---|
| M0→M1 | `llama-simple -ngl 99 -n 48`, unconfined (baseline, must succeed), then **confined** (`ROLE=llm`, weights read-only, scratch the only writable place) | **PASS.** Both: `using device MTL0 (Apple M4 Max)`, **`offloaded 37/37 layers to GPU`**, exit 0. The confined completion is *"…red, green, and blue. When these colors are combined in equal parts, they produce white light…"*, the same as unconfined. | `M0-unconfined.txt`, `M1-confined.txt` |
| M2 | Weights immutable: `touch` a fresh random name in the weights dir; open the `.gguf` for append (zero bytes); hard-link the `.gguf` into scratch | **PASS.** The unconfined baseline succeeds for all three; the created file was removed by exact path. Confined: all three print `<path>: Operation not permitted`, nothing is created, and the kernel logged `touch … deny file-write-create`, `sh` (bash) `… deny file-write-data <model>`, and `ln … deny forbidden-link-priv<file-write*>`. | `M2-weights-write.txt`, `sandbox-log.txt` |
| M3 | Confined `llama-server --host <LISTEN_SOCK>`; a **confined** assistant (`j0uclient`) calls `GET /health`, then `POST /completion` | **PASS.** Client exit 0, `HTTP/1.1 200`, `"content":" red, green, and blue. …"`. `lsof -a -p <server>` exits 0 (23 lines): the unix socket is present, **0 IPv4/IPv6**. | `M3-server.txt`, `M3-assistant.txt` |
| M4 | Model bytes unchanged | **PASS.** 64-hex sha256 identical before and after, and equal to Lane 2's `LANE2-READY` marker. | `env.txt`, `summary.txt` |
| M5 | GPU only for `ROLE=llm` | **PASS.** Unconfined and confined-llm list `MTL0: Apple M4 Max` (exit 0). Confined assistant exits 0 and lists no Metal device. | `M5-*.txt` |

**Metal and GPU work under the sandbox**, with full offload. The only allowances Metal needs are:

- `iokit-open` on `AGXDeviceUserClient`, `AGXSharedUserClient` and `IOSurfaceRootUserClient`;
- `iokit-get-properties`;
- the mach services `com.apple.MTLCompilerService` and `com.apple.gpumemd.source`.

`/dev/dtracehelper` is not needed (removed this pass).

**Performance: not measured.** Lane 2's evaluation was using the GPU concurrently. The recorded run gave 12.0 t/s confined against 13.2 t/s unconfined, and a trial run earlier the same afternoon gave 75 against 97. That spread is contention, not a sandbox measurement. Phase 1 must measure on an idle machine.

`/usr/bin/curl` still cannot be the confined client: Apple's LibreSSL reads `/private/etc/ssl/openssl.cnf` at start-up. The profile was not widened for it.

---

## 5. The profile, in one screen

`scripts/spike/j0-confined-child.sb`:

- `(deny default)`, then `(import "dyld-support.sb")`, Apple-maintained. It includes `file-read*` of the literal `/`; see §6.
- **Exec:** `EXEC_DIR` and `LIB_DIR` only. No `/bin/sh`, no `/usr/bin`. (`SYSTEM_EXEC=yes` is test-only.) Every descendant inherits the sandbox.
- **Process:** `(deny process-info*)`, then allow for `self` only. Signals to `self` only. `mach-priv-task-port` and `mach-task-name` denied. sysctl reads allowed except `kern.proc.*` and `kern.procargs*`.
- **Read:** the OS runtime (`/System` minus `/System/Volumes/Data`, `/usr/lib`, `/usr/share`, dyld, timezone, `/dev/{null,zero,random,urandom}`), plus the child's own `EXEC_DIR`, `LIB_DIR`, `WEIGHTS` and `SCRATCH`, and `IPC_DIR` for the assistant only. `stat` is allowed only on the ancestors of those paths.
- **Write:** `SCRATCH` only (plus `/dev/null`). With `ROLE=llm`, also the single literal `LISTEN_SOCK` node.
- **Network:** the assistant may make outbound connects only to unix sockets under `IPC_DIR`. The LLM has **no outbound at all**, and bind/inbound only on the literal `LISTEN_SOCK`. No TCP or UDP for anyone.
- **Mach:** **none** for the assistant. With `ROLE=llm`: `com.apple.MTLCompilerService` and `com.apple.gpumemd.source`, plus the three AGX/IOSurface IOKit user clients.

The launcher (`j0spawn.c`) supplies what a profile cannot:

- the bootstrap pipe on fd 3;
- closing **every** other fd by descriptor-table enumeration, and failing closed if any remain;
- a fixed 4-variable environment;
- `setsid` and `chdir`;
- process-group signal forwarding;
- wiping the secret from memory.

---

## 6. Findings and residual risks

1. **`(deny default)` does not cover process-info.** Without the explicit `(deny process-info*)`, `proc_pidpath`, `proc_pidinfo` and `proc_listallpids` on other processes succeed. Measured in the first pass, and covered by `proc.*` tests. **Phase 1 must keep these tests**, because this behaviour is undocumented.
2. **Descriptor closure must not trust `RLIMIT_NOFILE`.** Measured this pass: a loop bounded by the soft limit leaves readable host-private pipes at fds above a lowered limit and at ≥ 65536 (`fd.legacy_launcher_leaks`). Phase 1's Rust launcher must enumerate `PROC_PIDLISTFDS` (or use `closefrom` if Apple ever ships it) and verify.
3. **Deprecated, private interface.** `sandbox_init_with_parameters` and SBPL carry no stability promise. Mitigations: fail closed; the suite in CI and as a startup self-test; App Sandbox fallback.
4. **Literal `/` is listable.** `dyld-support.sb` grants `file-read*` on the root directory itself (not recursive). Denying it makes dyld abort before `main` (measured: exit 134). A child can list the top-level names of `/` and nothing below them (`/Users` itself is denied: `read.users_dir`).
5. **Readable OS areas.** `/System` (minus `/System/Volumes/Data`), `/usr/lib` and `/usr/share` are readable. They hold no user data, but a child can fingerprint the OS version.
6. **The broker is trusted.** It chooses the profile parameters and the environment; `--env` is a trusted-caller convention. A compromised broker is out of scope (THREAT-MODEL.md).
7. **Same-user malware is out of scope** (ARCHITECTURE §3.1).
8. **The Metal allowance is a larger attack surface** for the LLM role only: GPU driver user clients, `MTLCompilerService`, and unrestricted `iokit-get-properties` (property reads cannot usefully be scoped per class in SBPL). A GPU driver exploit would escape any userspace sandbox. That is accepted as residual; CPU-only (`-ngl 0`, dropping the IOKit and Metal rules) is available.
9. **Resource limits (T21) are not part of this spike.** `process-fork` is unrestricted, and there are no memory, CPU or disk quotas.
10. **Channels without runtime coverage:** POSIX shared memory and semaphores, System V IPC, pseudo-terminals, `nvram`, and `user-preference-read`. None is allowed by the profile (deny-default), but none is exercised by a test. Apple Events: only the mach lookup is tested; no event is sent, because of the no-GUI-automation rule.
11. **Egress is tested to this host's own LAN address, not the internet** (the mock-only rule). The profile has no TCP/UDP rule at all, so the remote address is irrelevant to the decision. During the run the dummy broker listens on the LAN address for a few seconds, and answers only this host.
12. **`task_for_pid` denial code is generic** (`KR5`). It is backed by the OK baseline, the lldb kernel log (`process-info-pidinfo others`) and the victim checks.
13. **Kernel-log corroboration depends on `log show`** returning Sandbox records for the user's own processes, as it does here, with a few seconds' delay. Where the log is unavailable, the affected controls score WEAK, not PASS.
14. **Integrity manifest** does not track atime.
15. **The unconfined baselines** (M0, and the M2 unconfined attempts) run real tools outside the sandbox. Their side effects outside the temp dirs are not audited, apart from the model dir: one random-named file was created and removed by exact path, and the model's sha256 is unchanged.
16. **Only the assistant and LLM roles were tested.** Other children need their own parameter sets through this suite. The §3.1a command boundary and the renderer tests are separate Phase 0.5 items.

---

## 7. Files

| Path | What |
|---|---|
| `scripts/spike/j0-confined-child.sb` | The SBPL profile (assistant and llm roles; `SYSTEM_EXEC` test-only) |
| `scripts/spike/j0spawn.c` | Launcher: bootstrap pipe, full fd closure (`PROC_PIDLISTFDS`, fail closed), env scrub, `setsid`/`chdir`, `sandbox_init_with_parameters`, exec, `--report` (child pid and secret sha256) |
| `scripts/spike/j0fdplant.c` | Hostile-parent helper: host-private pipes at high fds, soft limit lowered, exec |
| `scripts/spike/j0probe.c` | Attacker and probe run inside the child |
| `scripts/spike/dummy_broker.c` | Fake node port (v4, v6, UDP), `control.sock`, LLM and broker sockets, LAN egress target, SIGUSR1 counter, `--victim` mode |
| `scripts/spike/run-isolation-tests.sh` | Re-runnable isolation suite (PASS/WEAK/FAIL scoring, required-ID enumeration, kernel-log corroboration, redacted evidence) |
| `scripts/spike/j0uclient.c` | Minimal HTTP-over-unix-socket client (the assistant stand-in in M3) |
| `scripts/spike/run-model-load.sh` | Confined model load, weights immutability, socket-only server and assistant, GPU role split |
| `docs/spike/evidence/` | Redacted raw logs of the recorded runs |
| `.gitignore` | `*.gguf`, `*.safetensors`: weights never enter git |
