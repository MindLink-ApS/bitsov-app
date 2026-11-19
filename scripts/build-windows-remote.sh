#!/usr/bin/env bash
# Unsigned Windows x86_64 NSIS installer of the signet beta, remote node only.
#
# Usage:
#   bash scripts/build-windows-remote.sh --out <dir> [--overlay <file>]
#        [--runner auto|xwin|native] [--source-sha <40-hex>]
#        [--allow-downloads] [--check-only]
#
# --runner xwin    cross-build with cargo-xwin (macOS or Linux host, or the
#                  messense/cargo-xwin container). Needs cargo-xwin, makensis and
#                  the rustup target x86_64-pc-windows-msvc.
# --runner native  build on a Windows host (Git Bash) with the MSVC toolchain.
# --check-only     validate the overlay and the host, then stop. Nothing is built.
#
# The overlay must select a signet-only profile (src-tauri/src/profile.rs), bundle
# no node (externalBin: []) and build only the nsis target, or the script refuses.
#
# Nothing is downloaded unless --allow-downloads is given: Cargo runs offline,
# node_modules must already exist, and the cargo-xwin SDK cache and the Tauri NSIS
# cache must already be filled. Without that, the script stops and says which step
# would download. No signing, no upload, no publishing.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

TARGET=x86_64-pc-windows-msvc
OVERLAY="$ROOT/packaging/windows/tauri.windows-beta.conf.json"
OUT=""
RUNNER=auto
SOURCE_SHA=""
ALLOW_DOWNLOADS=0
CHECK_ONLY=0

die() { echo "build-windows-remote: $*" >&2; exit 2; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --out) [ "$#" -ge 2 ] || die "--out needs a directory"; OUT="$2"; shift 2 ;;
    --overlay) [ "$#" -ge 2 ] || die "--overlay needs a file"; OVERLAY="$2"; shift 2 ;;
    --runner) [ "$#" -ge 2 ] || die "--runner needs auto, xwin or native"; RUNNER="$2"; shift 2 ;;
    --source-sha) [ "$#" -ge 2 ] || die "--source-sha needs a value"; SOURCE_SHA="$2"; shift 2 ;;
    --allow-downloads) ALLOW_DOWNLOADS=1; shift ;;
    --check-only) CHECK_ONLY=1; shift ;;
    -h|--help) sed -n '2,21p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ -n "$OUT" ] || die "--out <dir> is required"
[ -f "$OVERLAY" ] || die "overlay not found: $OVERLAY"
OVERLAY="$(cd "$(dirname "$OVERLAY")" && pwd)/$(basename "$OVERLAY")"
command -v node >/dev/null 2>&1 || die "node is required"

# ---- 1. The overlay must be signet-only, node-free and NSIS-only ---------------
# The accepted identifiers are read from profile.rs, so this check follows the app.
validate_overlay() {
  node - "$OVERLAY" "$ROOT/src-tauri/src/profile.rs" <<'NODE'
const fs = require("fs");
const [overlayPath, profilePath] = process.argv.slice(2);
const fail = (why) => { console.error(`build-windows-remote: refusing overlay: ${why}`); process.exit(3); };
let config;
try { config = JSON.parse(fs.readFileSync(overlayPath, "utf8")); } catch (e) { fail(`not valid JSON (${e.message})`); }
// profile.rs is read as tokens, so comments, literals and code outside the policy items
// never count. This is a narrow check of the exact current source, not a Rust parser:
// anything it does not recognise refuses the build.
const POLICY = "profile.rs no longer maps the beta identifiers to signet_only";
const kinds = [["s", /[bc]?r(#*)"[^]*?"\1/y], ["!", /[bc]?r#*"/y], ["s", /[bc]?"(?:[^"\\]|\\[^])*"/y],
  ["c", /b?'(?:[^'\\\n]|\\(?:u\{[0-9a-fA-F]{1,6}\}|x[0-9a-fA-F]{2}|[^]))'/uy], ["l", /'[A-Za-z_]\w*/y],
  ["i", /r#[A-Za-z_]\w*|[A-Za-z_]\w*/y], ["n", /[0-9]\w*/y], ["p", /::|->|=>|[=!<>]=|&&|\|\||\.\.[.=]?|[^"'\s]/y]];
const lex = (src) => {
  const toks = [];
  for (let i = 0; i < src.length;) {
    if (/\s/.test(src[i])) { i++; continue; }
    if (src.startsWith("//", i)) { const eol = src.indexOf("\n", i); i = eol < 0 ? src.length : eol; continue; }
    if (src.startsWith("/*", i)) { // block comments nest in Rust
      let depth = 0;
      do {
        if (i >= src.length) fail(`${POLICY} (unterminated comment)`);
        if (src.startsWith("/*", i)) { depth++; i += 2; } else if (src.startsWith("*/", i)) { depth--; i += 2; } else i++;
      } while (depth > 0);
      continue;
    }
    const hit = kinds.find(([, re]) => { re.lastIndex = i; return re.test(src); });
    if (!hit || hit[0] === "!") fail(`${POLICY} (unterminated literal)`);
    toks.push({ k: hit[0], v: src.slice(i, hit[1].lastIndex) });
    i = hit[1].lastIndex;
  }
  return toks;
};
const T = lex(fs.readFileSync(profilePath, "utf8"));
const open = [];
T.forEach((t, n) => { // t.up: index of the innermost enclosing bracket, -1 at top level
  t.up = open.length ? open[open.length - 1] : -1;
  if (t.k !== "p") return;
  if ("([{".includes(t.v)) open.push(n);
  else if (")]}".includes(t.v) && (!open.length || T[open.pop()].v !== "([{"[")]}".indexOf(t.v)])) fail(`${POLICY} (unbalanced brackets)`);
});
if (open.length) fail(`${POLICY} (unbalanced brackets)`);
// The one `fn`/`const`/`impl` definition of the name in `text`, anywhere in the file: it
// must sit directly in `parent` (-1: top level), carry no attribute, and consist of
// exactly the tokens of `text`. Returns the index after it, or -1.
const item = (text, parent) => {
  const want = lex(text);
  const key = want.findIndex((t) => ["fn", "const", "impl"].includes(t.v));
  const hits = T.flatMap((t, n) => (t.v === want[key].v && T[n + 1] && T[n + 1].v === want[key + 1].v ? [n - key] : []));
  const s = hits[0];
  if (hits.length !== 1 || s < 0 || T[s].up !== parent || (s > 0 && !";{}".includes(T[s - 1].v))) return -1;
  return want.every((t, n) => T[s + n] && T[s + n].k === t.k && T[s + n].v === t.v) ? s + want.length : -1;
};
const constant = (name) => {
  const end = item(`const ${name}: &str =`, -1);
  const lit = T[end], semi = T[end + 1];
  if (end < 0 || !lit || lit.k !== "s" || !/^"[^"\\]*"$/.test(lit.v) || !semi || semi.v !== ";") fail(`profile.rs no longer defines ${name}`);
  return lit.v.slice(1, -1);
};
const beta = constant("BETA_IDENTIFIER");
const remote = constant("REMOTE_TEST_IDENTIFIER");
// for_platform must build exactly this struct, with either the inline policy or the shared
// helper (desktop builds are not mobile, so its `mobile ||` cannot loosen the beta ids).
const ids = "matches!(identifier, BETA_IDENTIFIER | REMOTE_TEST_IDENTIFIER)";
const ctor = (expr) => `pub(crate) fn for_platform(identifier: &str, mobile: bool) -> Self { Self {
  remote_only: identifier == REMOTE_TEST_IDENTIFIER, signet_only: ${expr}, beta_storage: identifier == BETA_IDENTIFIER, } }`;
const impl = item("impl AppProfile {", -1);
const method = (text) => impl >= 0 && item(text, impl - 1) >= 0;
const policy = method("pub(crate) fn for_identifier(identifier: &str) -> Self { Self::for_platform(identifier, phone_build()) }")
  && (method(ctor(ids)) || (method(ctor("signet_only_for(identifier, mobile)"))
    && item(`pub(crate) fn signet_only_for(identifier: &str, mobile: bool) -> bool { mobile || ${ids} }`, -1) >= 0));
// `matches!` must be the standard macro: no macro definitions, macro imports, inner
// attributes or top-level imports other than the current one.
const plain = T.every((t, n) => !["macro_rules", "macro_use", "extern"].includes(t.v)
  && !(t.v === "#" && T[n + 1] && T[n + 1].v === "!")
  && (t.v !== "use" || t.up !== -1 || T.slice(n, n + 7).map((u) => u.v).join(" ") === "use std :: sync :: OnceLock ;"));
if (!policy || !plain) fail(POLICY);
const id = config.identifier;
if (id !== beta && id !== remote) fail(`identifier ${JSON.stringify(id)} is not signet-only (expected ${beta} or ${remote})`);
const bundle = config.bundle;
if (!bundle || typeof bundle !== "object") fail("no bundle section");
if (!Array.isArray(bundle.externalBin) || bundle.externalBin.length !== 0) fail("bundle.externalBin must be [] (no node in the installer)");
if (!Array.isArray(bundle.targets) || bundle.targets.length !== 1 || bundle.targets[0] !== "nsis") fail('bundle.targets must be exactly ["nsis"]');
// The installer never downloads anything: WebView2 must already be on the machine (Windows 11 has it).
const webview = bundle.windows && bundle.windows.webviewInstallMode;
if (!webview || webview.type !== "skip") fail('bundle.windows.webviewInstallMode must be {"type":"skip"} (no download at install time)');
const before = (config.build && config.build.beforeBundleCommand) || "";
if (typeof before !== "string" || before === "" || /fetch-node-sidecar/.test(before)) {
  fail("build.beforeBundleCommand must replace the sidecar fetch/verify step");
}
if (!config.productName) fail("productName is missing");
console.log(`${id}\t${config.productName}`);
NODE
}
PROFILE_LINE="$(validate_overlay)" || exit 3
BUNDLE_ID="${PROFILE_LINE%%$'\t'*}"
PRODUCT="${PROFILE_LINE#*$'\t'}"
echo "overlay ok: $BUNDLE_ID ($PRODUCT), signet-only, no bundled node, nsis, no WebView2 download"

# ---- 2. Host preflight: refuse every step that would download ----------------
if [ "$RUNNER" = auto ]; then
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) RUNNER=native ;;
    *) RUNNER=xwin ;;
  esac
fi
case "$RUNNER" in xwin|native) ;; *) die "--runner must be auto, xwin or native" ;; esac

if git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  HEAD_SHA="$(git -C "$ROOT" rev-parse HEAD)"
  [ -z "$SOURCE_SHA" ] || [ "$SOURCE_SHA" = "$HEAD_SHA" ] || die "--source-sha does not match the checkout HEAD $HEAD_SHA"
  SOURCE_SHA="$HEAD_SHA"
  # icon.ico is the one file this script may generate in the tree.
  if [ -n "$(git -C "$ROOT" status --porcelain --untracked-files=normal -- . ':!src-tauri/icons/icon.ico')" ]; then
    die "the checkout has local changes; build from a clean tree"
  fi
elif [ -z "$SOURCE_SHA" ]; then
  die "no git checkout: pass --source-sha <40-hex> for a source archive"
fi
[[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] || die "the source SHA must be 40 lowercase hex characters"

host_cache() { # dirs::cache_dir() as cargo-xwin and the Tauri bundler use it
  case "$(uname -s)" in
    Darwin) echo "$HOME/Library/Caches" ;;
    MINGW*|MSYS*|CYGWIN*) echo "${LOCALAPPDATA:-$HOME/AppData/Local}" ;;
    *) echo "${XDG_CACHE_HOME:-$HOME/.cache}" ;;
  esac
}
sha1_of() {
  if command -v sha1sum >/dev/null 2>&1; then sha1sum "$1"; else shasum -a 1 "$1"; fi | cut -d' ' -f1 | tr 'A-F' 'a-f'
}
# A cache only counts when the tool itself would reuse it without going online.
# cargo-xwin 0.23 reuses <cache>/xwin only when the first line of its DONE marker lists every
# requested architecture (whitespace-separated); otherwise it loads the manifest over the network.
# This build requests x86_64 only (XWIN_ARCH is set below), so the marker must list x86_64.
XWIN_ARCH_PINNED=x86_64
xwin_cache_complete() {
  # cargo-xwin reads the whole marker as UTF-8 first; any invalid byte (on any line) leaves its
  # architecture list empty and sends it to the network, so the marker must decode in full.
  [ -r "$1/xwin/DONE" ] &&
    node -e 'try { new (require("util").TextDecoder)("utf-8", { fatal: true }).decode(require("fs").readFileSync(process.argv[1])); } catch { process.exit(1); }' "$1/xwin/DONE" &&
    awk -v want="$XWIN_ARCH_PINNED" 'NR == 1 { for (i = 1; i <= NF; i++) if ($i == want) ok = 1 } END { exit !ok }' "$1/xwin/DONE"
}
# Tauri 2.12.0 (the CLI pinned in package-lock.json) reuses <cache>/tauri/NSIS only when its required
# files exist and the plugin matches this SHA-1 (tauri-bundler, bundle/windows/nsis/mod.rs); otherwise it downloads.
TAURI_CLI_VERSION=2.12.0
NSIS_TAURI_UTILS_SHA1=75197fee3c6a814fe035788d1c34ead39349b860
nsis_cache_complete() {
  local dir="$1" file
  local required=(Plugins/x86-unicode/additional/nsis_tauri_utils.dll)
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) required+=(makensis.exe Bin/makensis.exe Stubs/lzma-x86-unicode Stubs/lzma_solid-x86-unicode
      Include/MUI2.nsh Include/FileFunc.nsh Include/x64.nsh Include/nsDialogs.nsh Include/WinMessages.nsh
      Include/Win/COM.nsh Include/Win/Propkey.nsh Include/Win/RestartManager.nsh) ;;
  esac
  for file in "${required[@]}"; do [ -f "$dir/$file" ] || return 1; done
  [ "$(sha1_of "$dir/Plugins/x86-unicode/additional/nsis_tauri_utils.dll")" = "$NSIS_TAURI_UTILS_SHA1" ]
}

LOCKED_TAURI_CLI="$(node -e 'const l=require(process.argv[1]);const p=l.packages&&l.packages["node_modules/@tauri-apps/cli"];process.stdout.write(p?p.version:"")' "$ROOT/package-lock.json" 2>/dev/null || true)"
[ "$LOCKED_TAURI_CLI" = "$TAURI_CLI_VERSION" ] || die "package-lock.json pins Tauri CLI ${LOCKED_TAURI_CLI:-?}; the NSIS cache check is written for $TAURI_CLI_VERSION, update it first"
# The executable that will run must be that version too (a stale node_modules can hold another one).
installed_tauri_ok() {
  [ -x "$ROOT/node_modules/.bin/tauri" ] &&
    [ "$("$ROOT/node_modules/.bin/tauri" --version 2>/dev/null | head -n 1)" = "tauri-cli $TAURI_CLI_VERSION" ]
}
if [ -x "$ROOT/node_modules/.bin/tauri" ] && ! installed_tauri_ok; then
  die "node_modules has a Tauri CLI other than $TAURI_CLI_VERSION; reinstall from package-lock.json (npm ci) first"
fi

DOWNLOADS=()
MISSING=()
# Both caches are where the tools themselves look: XWIN_CACHE_DIR is exported to cargo-xwin below,
# and the Tauri bundler always uses the OS cache folder (it has no cache setting of its own).
XWIN_CACHE="${XWIN_CACHE_DIR:-$(host_cache)/cargo-xwin}"
TAURI_NSIS_CACHE="$(host_cache)/tauri/NSIS"

if [ "$RUNNER" = xwin ]; then
  command -v cargo-xwin >/dev/null 2>&1 || MISSING+=("cargo-xwin (cargo install --locked cargo-xwin, or the messense/cargo-xwin image)")
  command -v makensis >/dev/null 2>&1 || MISSING+=("makensis (NSIS 3)")
  if command -v rustup >/dev/null 2>&1; then
    rustup target list --installed | grep -qx "$TARGET" || MISSING+=("rustup target $TARGET")
  else
    MISSING+=("rustup")
  fi
  # The SDK and CRT versions are chosen explicitly, never cargo-xwin's latest-available default.
  [ -n "${XWIN_SDK_VERSION:-}" ] || MISSING+=("XWIN_SDK_VERSION (the Windows SDK version to build against)")
  [ -n "${XWIN_CRT_VERSION:-}" ] || MISSING+=("XWIN_CRT_VERSION (the MSVC CRT version to build against)")
  xwin_cache_complete "$XWIN_CACHE" || DOWNLOADS+=("cargo-xwin would download the MSVC CRT and Windows SDK into $XWIN_CACHE (no complete $XWIN_ARCH_PINNED cache: xwin/DONE does not list it)")
else
  command -v cargo >/dev/null 2>&1 || MISSING+=("cargo with the MSVC toolchain")
fi
nsis_cache_complete "$TAURI_NSIS_CACHE" || DOWNLOADS+=("the Tauri bundler would download its NSIS tools into $TAURI_NSIS_CACHE (missing or mismatched files)")
[ -x "$ROOT/node_modules/.bin/tauri" ] || DOWNLOADS+=("npm ci would download node_modules")

if [ "${#MISSING[@]}" -gt 0 ]; then
  printf 'build-windows-remote: missing host tool: %s\n' "${MISSING[@]}" >&2
  exit 4
fi
if [ "${#DOWNLOADS[@]}" -gt 0 ]; then
  if [ "$ALLOW_DOWNLOADS" != 1 ]; then
    printf 'build-windows-remote: refusing, this step would download: %s\n' "${DOWNLOADS[@]}" >&2
    echo "build-windows-remote: rerun with --allow-downloads on a host where that is allowed." >&2
    exit 5
  fi
  printf 'build-windows-remote: allowed download: %s\n' "${DOWNLOADS[@]}"
fi

echo "preflight ok: runner=$RUNNER source=$SOURCE_SHA allow-downloads=$ALLOW_DOWNLOADS"
if [ "$CHECK_ONLY" = 1 ]; then
  echo "check only: nothing built"
  exit 0
fi

# ---- 3. Build ---------------------------------------------------------------
if [ "$ALLOW_DOWNLOADS" != 1 ]; then
  export CARGO_NET_OFFLINE=true
  export npm_config_offline=true
fi
if [ "$RUNNER" = xwin ]; then
  export XWIN_CACHE_DIR="$XWIN_CACHE" XWIN_SDK_VERSION XWIN_CRT_VERSION XWIN_ARCH="$XWIN_ARCH_PINNED"
fi
if [ ! -x "$ROOT/node_modules/.bin/tauri" ]; then
  npm ci --no-audit --no-fund
fi
installed_tauri_ok || die "the installed Tauri CLI is not $TAURI_CLI_VERSION; refusing to build"

# Tauri embeds a Windows .ico; the repo keeps only PNG/ICNS (src-tauri/icons/README.md).
if [ ! -f src-tauri/icons/icon.ico ]; then
  ICON_TMP="$(mktemp -d)"
  npm run --silent tauri -- icon src-tauri/icons/icon.png --output "$ICON_TMP" >/dev/null
  cp "$ICON_TMP/icon.ico" src-tauri/icons/icon.ico
  rm -rf "$ICON_TMP"
fi

export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/src-tauri/target}"
RELEASE_DIR="$CARGO_TARGET_DIR/$TARGET/release"
NSIS_DIR="$RELEASE_DIR/bundle/nsis"
rm -rf "$NSIS_DIR"

BUILD=(npm run tauri -- build --ci --no-sign --target "$TARGET" --bundles nsis --config "$OVERLAY")
[ "$RUNNER" = xwin ] && BUILD+=(--runner cargo-xwin)
BUILD+=(-- --locked)
if command -v nice >/dev/null 2>&1; then nice -n 10 "${BUILD[@]}"; else "${BUILD[@]}"; fi

# ---- 4. Check, copy and record -----------------------------------------------
shopt -s nullglob
installers=("$NSIS_DIR"/*-setup.exe)
sidecars=("$RELEASE_DIR"/konsensus*)
shopt -u nullglob
[ "${#installers[@]}" = 1 ] || { echo "build-windows-remote: expected exactly one NSIS installer in $NSIS_DIR" >&2; exit 1; }
[ "${#sidecars[@]}" = 0 ] || { echo "build-windows-remote: a node binary is next to the app build: ${sidecars[*]}" >&2; exit 1; }

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi
}
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
NAME="BitSov-beta-signet-windows-x64-${SOURCE_SHA:0:12}-setup.exe"
cp "${installers[0]}" "$OUT/$NAME"
{
  echo "source.sha=$SOURCE_SHA"
  echo "bundle.identifier=$BUNDLE_ID"
  echo "product.name=$PRODUCT"
  echo "target=$TARGET"
  echo "bundle=nsis"
  echo "webview.install=skip (the installer never downloads WebView2)"
  [ "$RUNNER" != xwin ] || echo "xwin.sdk=$XWIN_SDK_VERSION xwin.crt=$XWIN_CRT_VERSION xwin.arch=$XWIN_ARCH_PINNED"
  echo "runner=$RUNNER"
  echo "profile=signet-only (selected by bundle identifier); remote node only on Windows"
  echo "bundled.node=absent"
  echo "signing=none (unsigned; SmartScreen will warn)"
  echo "overlay.sha256=$(sha256 "$OVERLAY" | awk '{print $1}')"
  echo "profile.rs.sha256=$(sha256 src-tauri/src/profile.rs | awk '{print $1}')"
  echo "downloads.allowed=$ALLOW_DOWNLOADS"
  echo "node=$(node --version)"
  echo "rustc=$(rustc --version 2>/dev/null || echo unknown)"
  echo "cargo=$(cargo --version 2>/dev/null || echo unknown)"
  [ "$RUNNER" = xwin ] && echo "cargo-xwin=$(cargo-xwin --version 2>/dev/null || echo unknown)"
  echo "host=$(uname -sm)"
} > "$OUT/build-info.txt"
(
  cd "$OUT"
  sha256 "$NAME" build-info.txt > SHA256SUMS
  if command -v sha256sum >/dev/null 2>&1; then sha256sum -c SHA256SUMS; else shasum -a 256 -c SHA256SUMS; fi
)
echo "Windows installer, build-info.txt and verified SHA256SUMS: $OUT"
