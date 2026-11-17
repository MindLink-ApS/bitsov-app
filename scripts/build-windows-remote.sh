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
const profile = fs.readFileSync(profilePath, "utf8");
const constant = (name) => {
  const m = profile.match(new RegExp(`const ${name}: &str = "([^"]+)";`));
  if (!m) fail(`profile.rs no longer defines ${name}`);
  return m[1];
};
const beta = constant("BETA_IDENTIFIER");
const remote = constant("REMOTE_TEST_IDENTIFIER");
if (!/signet_only:\s*matches!\(identifier,\s*BETA_IDENTIFIER\s*\|\s*REMOTE_TEST_IDENTIFIER\)/.test(profile)) {
  fail("profile.rs no longer maps the beta identifiers to signet_only");
}
const id = config.identifier;
if (id !== beta && id !== remote) fail(`identifier ${JSON.stringify(id)} is not signet-only (expected ${beta} or ${remote})`);
const bundle = config.bundle;
if (!bundle || typeof bundle !== "object") fail("no bundle section");
if (!Array.isArray(bundle.externalBin) || bundle.externalBin.length !== 0) fail("bundle.externalBin must be [] (no node in the installer)");
if (!Array.isArray(bundle.targets) || bundle.targets.length !== 1 || bundle.targets[0] !== "nsis") fail('bundle.targets must be exactly ["nsis"]');
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
echo "overlay ok: $BUNDLE_ID ($PRODUCT), signet-only, no bundled node, nsis"

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
nonempty_dir() { [ -d "$1" ] && [ -n "$(ls -A "$1" 2>/dev/null)" ]; }

DOWNLOADS=()
MISSING=()
XWIN_CACHE="${XWIN_CACHE_DIR:-$(host_cache)/cargo-xwin}"
TAURI_NSIS_CACHE="${BITSOV_TAURI_NSIS_CACHE:-$(host_cache)/tauri/NSIS}"

if [ "$RUNNER" = xwin ]; then
  command -v cargo-xwin >/dev/null 2>&1 || MISSING+=("cargo-xwin (cargo install --locked cargo-xwin, or the messense/cargo-xwin image)")
  command -v makensis >/dev/null 2>&1 || MISSING+=("makensis (NSIS 3)")
  if command -v rustup >/dev/null 2>&1; then
    rustup target list --installed | grep -qx "$TARGET" || MISSING+=("rustup target $TARGET")
  else
    MISSING+=("rustup")
  fi
  nonempty_dir "$XWIN_CACHE" || DOWNLOADS+=("cargo-xwin would download the MSVC CRT and Windows SDK into $XWIN_CACHE")
else
  command -v cargo >/dev/null 2>&1 || MISSING+=("cargo with the MSVC toolchain")
fi
nonempty_dir "$TAURI_NSIS_CACHE" || DOWNLOADS+=("the Tauri bundler would download its NSIS tools into $TAURI_NSIS_CACHE")
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
if [ ! -x "$ROOT/node_modules/.bin/tauri" ]; then
  npm ci --no-audit --no-fund
fi

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
