# Real-window regtest

`scripts/ui-e2e-real-regtest.sh /absolute/path/to/genome-with-PR106`
combines the real WKWebView driver from `scripts/ui-e2e-two-node.sh` with the
Bitcoin Core, Esplora electrs and routing-only LDK fixture from genome PR #106.
Set `BITCOIND_EXE` and `ELECTRS_EXE` to existing cached executables. Rust, npm,
and the Tauri CLI dependencies must already exist; downloads are disabled.
The genome integration must contain both main `a97ab0e` (or a descendant)
and PR #106. The runner checks ancestry before building: the cached PR branch
alone can predate the required main even when its own latest commit is newer.

The app starts its own production konsensus node A through `dev-node`. A and B
use real LDK and Esplora on regtest. C is the harness's LSPS2-enabled private
channel router. There is no A–B channel. Fresh coinbase funds only the disposable
regtest wallets. A–C and C–B each have 1,000,000-sat capacity; a 50,000,000-msat
payment supplies reply liquidity before measured UI actions.

The fixture is included only in a disposable archive of the specified genome
commit. The original checkout is not edited. The Tauri app source remains at
its checked-out revision. A separate bundle identifier keeps test UI caches
separate from the normal app. Node data, fixture files, generated Swift cache,
and that identifier's UI caches are removed on exit. Pre-existing shared Cargo
and executable caches are retained; never delete another run's cache.

Current app API port 3141 and Vite port 1420 must be free. The harness refuses
occupied ports and never stops their owners. Other listeners use ephemeral
127.0.0.1 ports. Seatbelt accepts `localhost`, which includes local LAN
addresses; explicit configuration and sampled socket checks constrain and
observe the actual nodes. The checks cannot prove absence of short-lived
connections between samples.

The UI scenario checks first-contact quote and owner CLI consent, real paid
delivery, a listed peer's paid reply, a fee-cap refusal, Body counters,
readiness, payment preimages and msat-exact channel reconciliation. B's owner
sends the reply via its real API; A receives it in the real window. To exercise
the UI's fixed 5,000-msat routing ceiling, C temporarily advertises a
6,000-msat fee. The fixture confirms that fee in B's invoice route hint before
the UI attempts payment, then restores C's 1,000-msat fee.

Evidence goes to a private `/tmp/real-ui-e2e-evidence.*` directory. The driver
serializes the real window DOM, and the harness attempts native captures of
windows belonging to its own app descendants. It never captures the desktop.
Native screenshot failure is reported, not silently treated as success.
Evidence is scanned with the run's exact known credentials and the existing
media-aware scanner. Native image pixels are not OCR-scanned; only the test
app window is captured, using disposable identities.
