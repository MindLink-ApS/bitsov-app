#!/usr/bin/env bash
# Guard tests for scripts/build-windows-remote.sh. No build, no network: every case
# stops at --check-only or earlier. The script runs from a throwaway copy of the
# tree (no git), with stub host tools on PATH, so results do not depend on the host.
# bash 3.2 compatible. Exit 1 on any failure.
set -euo pipefail
cd "$(dirname "$0")/.."

T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/root/scripts" "$T/root/src-tauri/src" "$T/root/packaging/windows" "$T/bin" "$T/cache"
cp scripts/build-windows-remote.sh "$T/root/scripts/"
cp src-tauri/src/profile.rs "$T/root/src-tauri/src/"
cp packaging/windows/tauri.windows-beta.conf.json "$T/root/packaging/windows/"
cp package-lock.json "$T/root/"
SCRIPT="$T/root/scripts/build-windows-remote.sh"
GOOD="$T/root/packaging/windows/tauri.windows-beta.conf.json"
SHA=0123456789abcdef0123456789abcdef01234567

# Stub host tools; only the preflight looks at them.
for tool in cargo-xwin makensis; do printf '#!/bin/sh\nexit 0\n' > "$T/bin/$tool"; done
printf '#!/bin/sh\necho x86_64-pc-windows-msvc\n' > "$T/bin/rustup"
chmod +x "$T/bin/"*
NODE_DIR="$(dirname "$(command -v node)")"
SAFE_PATH="$T/bin:$NODE_DIR:/usr/bin:/bin"

# The NSIS plugin fixture is not Tauri's real DLL, so the throwaway copy of the script expects the
# fixture's SHA-1 instead; the shipped script keeps Tauri's pinned value (checked here first).
grep -qx 'NSIS_TAURI_UTILS_SHA1=75197fee3c6a814fe035788d1c34ead39349b860' "$SCRIPT" || { echo "FAIL: the shipped NSIS plugin SHA-1 changed"; exit 1; }
printf 'nsis tauri utils fixture\n' > "$T/fixture.dll"
FIXTURE_SHA1="$( (command -v sha1sum >/dev/null 2>&1 && sha1sum "$T/fixture.dll") || shasum -a 1 "$T/fixture.dll")"
FIXTURE_SHA1="${FIXTURE_SHA1%% *}"
sed -i.bak "s/^NSIS_TAURI_UTILS_SHA1=.*/NSIS_TAURI_UTILS_SHA1=$FIXTURE_SHA1/" "$SCRIPT" && rm -f "$SCRIPT.bak"

# Where the Tauri bundler keeps its NSIS cache for a given home (dirs::cache_dir()).
nsis_dir() { case "$(uname -s)" in Darwin) echo "$1/Library/Caches/tauri/NSIS" ;; *) echo "$1/.cache/tauri/NSIS" ;; esac; }
fill_nsis() { mkdir -p "$(nsis_dir "$1")/Plugins/x86-unicode/additional"; cp "$T/fixture.dll" "$(nsis_dir "$1")/Plugins/x86-unicode/additional/nsis_tauri_utils.dll"; }
SDKV=10.0.22621; CRTV=14.40

FAILS=0
CASE=""
run() { # <expected-exit> <expected-text> <args...>
  local want="$1" text="$2" got=0 out
  shift 2
  out="$(env -u XWIN_SDK_VERSION -u XWIN_CRT_VERSION PATH="$SAFE_PATH" HOME="$HOMEDIR" XDG_CACHE_HOME="$HOMEDIR/.cache" XWIN_CACHE_DIR="$XWIN" \
    ${SDKV:+XWIN_SDK_VERSION="$SDKV"} ${CRTV:+XWIN_CRT_VERSION="$CRTV"} bash "$SCRIPT" "$@" 2>&1)" || got=$?
  if [ "$got" != "$want" ] || ! printf '%s' "$out" | grep -qF -- "$text"; then
    echo "FAIL: ${CASE:+$CASE: }$* -> exit $got (want $want), output:"; echo "$out"; FAILS=$((FAILS + 1))
  else
    echo "ok: ${CASE:+$CASE: }exit $got, $text"
  fi
}
overlay() { # <name> <node expression applied to config c>
  node -e 'const fs=require("fs");const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));'"$2"';fs.writeFileSync(process.argv[2],JSON.stringify(c));' \
    "$GOOD" "$T/$1.json"
  echo "$T/$1.json"
}

# Filled caches and node_modules: preflight passes without downloads.
XWIN="$T/cache/xwin"; HOMEDIR="$T/home-full"
mkdir -p "$XWIN/xwin" "$T/root/node_modules/.bin"; printf 'x86_64\nsdk/include\n' > "$XWIN/xwin/DONE"; fill_nsis "$HOMEDIR"
tauri_stub() { # <version>: a stand-in Tauri CLI that only answers --version
  cat > "$T/root/node_modules/.bin/tauri" <<STUB
#!/bin/sh
[ "\$1" = --version ] && echo "tauri-cli $1"
exit 0
STUB
  chmod +x "$T/root/node_modules/.bin/tauri"
}
tauri_stub 2.12.0

run 0 "check only: nothing built" --out "$T/out" --runner xwin --source-sha "$SHA" --check-only
run 0 "overlay ok: tech.mindlink.bitsov.beta" --out "$T/out" --runner xwin --source-sha "$SHA" --check-only
run 0 "overlay ok: tech.mindlink.bitsov.remotetest" --out "$T/out" --runner xwin --source-sha "$SHA" --check-only \
  --overlay "$(overlay remotetest 'c.identifier="tech.mindlink.bitsov.remotetest"')"

# Signet-only and node-free are enforced.
run 3 "is not signet-only" --out "$T/out" --runner xwin --source-sha "$SHA" --check-only \
  --overlay "$(overlay mainnet 'c.identifier="tech.mindlink.bitsov"')"
run 3 "is not signet-only" --out "$T/out" --runner xwin --source-sha "$SHA" --check-only \
  --overlay "$(overlay lookalike 'c.identifier="tech.mindlink.bitsov.beta.extra"')"
run 3 "is not signet-only" --out "$T/out" --runner xwin --source-sha "$SHA" --check-only \
  --overlay "$(overlay noid 'delete c.identifier')"
run 3 "externalBin must be []" --out "$T/out" --runner xwin --source-sha "$SHA" --check-only \
  --overlay "$(overlay sidecar 'c.bundle.externalBin=["bin/konsensus"]')"
run 3 "externalBin must be []" --out "$T/out" --runner xwin --source-sha "$SHA" --check-only \
  --overlay "$(overlay inherit 'delete c.bundle.externalBin')"
run 3 'targets must be exactly ["nsis"]' --out "$T/out" --runner xwin --source-sha "$SHA" --check-only \
  --overlay "$(overlay msi 'c.bundle.targets=["nsis","msi"]')"
run 3 "must replace the sidecar fetch" --out "$T/out" --runner xwin --source-sha "$SHA" --check-only \
  --overlay "$(overlay fetch 'c.build.beforeBundleCommand="bash scripts/fetch-node-sidecar.sh --verify-only"')"
run 3 "must replace the sidecar fetch" --out "$T/out" --runner xwin --source-sha "$SHA" --check-only \
  --overlay "$(overlay nobefore 'delete c.build')"
printf '{ not json' > "$T/broken.json"
run 3 "not valid JSON" --out "$T/out" --runner xwin --source-sha "$SHA" --check-only --overlay "$T/broken.json"
# The installer never downloads WebView2.
run 3 "webviewInstallMode must be" --out "$T/out" --runner xwin --source-sha "$SHA" --check-only \
  --overlay "$(overlay nowebview 'delete c.bundle.windows.webviewInstallMode')"
run 3 "webviewInstallMode must be" --out "$T/out" --runner xwin --source-sha "$SHA" --check-only \
  --overlay "$(overlay bootstrapper 'c.bundle.windows.webviewInstallMode={type:"downloadBootstrapper"}')"
run 3 "webviewInstallMode must be" --out "$T/out" --runner xwin --source-sha "$SHA" --check-only \
  --overlay "$(overlay embedded 'c.bundle.windows.webviewInstallMode={type:"embedBootstrapper"}')"

# ---- profile.rs policy -------------------------------------------------------
# The guard accepts only the exact signet policy of AppProfile::for_platform: the
# shared helper form or the inline form. Every case starts from a pristine copy and
# runs against both the beta and the remote-test overlay.
PROFILE="$T/root/src-tauri/src/profile.rs"
H="$T/profile.helper.rs"; I="$T/profile.inline.rs"
cp "$PROFILE" "$H"
REMOTE="$(overlay remotetest 'c.identifier="tech.mindlink.bitsov.remotetest"')"
NL=$'\n'
POLICY="no longer maps the beta identifiers"
IDS="matches!(identifier, BETA_IDENTIFIER | REMOTE_TEST_IDENTIFIER)"
BODY="mobile || $IDS"
FIELD="signet_only: signet_only_for(identifier, mobile),"
IFIELD="signet_only: $IDS,"
SIG="pub(crate) fn signet_only_for(identifier: &str, mobile: bool) -> bool {"
HELPER="$SIG$NL    $BODY$NL}"
GOODHELPER="$SIG $BODY }"
CTOR="pub(crate) fn for_platform(identifier: &str, mobile: bool) -> Self {"
CTOR_END="beta_storage: identifier == BETA_IDENTIFIER,$NL        }"
FWD="Self::for_platform(identifier, phone_build())"
IMPL="impl AppProfile {"
BETA_DECL='const BETA_IDENTIFIER: &str = "tech.mindlink.bitsov.beta";'
REMOTE_DECL='const REMOTE_TEST_IDENTIFIER: &str = "tech.mindlink.bitsov.remotetest";'
OFF="Self { remote_only: false, signet_only: false, beta_storage: false }"

both() { # <expected-exit> <expected-text>: the beta overlay, then the remote-test overlay
  run "$1" "$2" --out "$T/out" --runner xwin --source-sha "$SHA" --check-only
  run "$1" "$2" --out "$T/out" --runner xwin --source-sha "$SHA" --check-only --overlay "$REMOTE"
}
# mutate <base> <case> <from> <to> [<from> <to>...]: copy <base> to profile.rs, replacing
# each exact fragment, which must occur exactly once. A mutation that does not apply
# is a failure and leaves the pristine file, so it is never counted as a refusal.
mutate() {
  local base="$1"
  CASE="$2"; shift 2
  if ! node - "$base" "$PROFILE" "$@" <<'JS' || cmp -s "$base" "$PROFILE"; then
const fs = require("fs");
const [base, out, ...pairs] = process.argv.slice(2);
let s = fs.readFileSync(base, "utf8");
for (let n = 0; n < pairs.length; n += 2) {
  const count = s.split(pairs[n]).length - 1;
  if (count !== 1 || n + 1 >= pairs.length) { console.error("fragment occurs " + count + " times: " + pairs[n]); process.exit(1); }
  s = s.replace(pairs[n], () => pairs[n + 1]);
}
fs.writeFileSync(out, s);
JS
    echo "FAIL: $CASE: profile.rs mutation did not apply"; FAILS=$((FAILS + 1))
    cp "$H" "$PROFILE"
  fi
}
refuse() { mutate "$@"; both 3 "$POLICY"; }
accept() { mutate "$@"; both 0 "check only: nothing built"; }

# Positive controls.
CASE=P01_current_helper; cp "$H" "$PROFILE"; both 0 "check only: nothing built"
accept "$H" P02_inline "$FIELD" "$IFIELD"; cp "$PROFILE" "$I"
accept "$H" P03_comments_between_tokens "$FIELD" "signet_only: /* beta ids */ signet_only_for(identifier, // phone$NL mobile)," \
  "$BODY" "mobile /* phone */ || matches!(identifier, BETA_IDENTIFIER /* | other */ | REMOTE_TEST_IDENTIFIER)"
accept "$H" P04_line_breaks "$FIELD" "signet_only:$NL            signet_only_for($NL                identifier,$NL                mobile$NL            ),"
CASE=P05_crlf_tabs; awk '{ sub(/^ +/, "\t\t"); printf "%s\r\n", $0 }' "$H" > "$PROFILE"; both 0 "check only: nothing built"
accept "$H" P06_misleading_text "$IMPL" "// signet_only: false,$NL/* $FIELD */${NL}const _NOTE: &str = \"signet_only: false, } { fn signet_only_for(\";${NL}fn _decoy<'a>(s: &'a str) -> (char, &'a str) { ('}', s) }$NL$IMPL"

# N01-N09: the helper-mode field must be exactly the helper call.
refuse "$H" N01_helper_suffix_mobile "$FIELD" "signet_only: signet_only_for(identifier, mobile) && mobile,"
refuse "$H" N02_helper_suffix_false "$FIELD" "signet_only: signet_only_for(identifier, mobile) && false,"
refuse "$H" N03_helper_or_false "$FIELD" "signet_only: signet_only_for(identifier, mobile) || false,"
refuse "$H" N03_helper_eq_false "$FIELD" "signet_only: signet_only_for(identifier, mobile) == false,"
refuse "$H" N04_helper_not "$FIELD" "signet_only: !signet_only_for(identifier, mobile),"
refuse "$H" N04_helper_false_and "$FIELD" "signet_only: false && signet_only_for(identifier, mobile),"
refuse "$H" N05_parens "$FIELD" "signet_only: (signet_only_for(identifier, mobile)),"
refuse "$H" N05_parens_and_false "$FIELD" "signet_only: (signet_only_for(identifier, mobile) && false),"
refuse "$H" N06_block "$FIELD" "signet_only: { signet_only_for(identifier, mobile); false },"
refuse "$H" N06_if "$FIELD" "signet_only: if mobile { signet_only_for(identifier, mobile) } else { false },"
refuse "$H" N07_arg_false "$FIELD" "signet_only: signet_only_for(identifier, false),"
refuse "$H" N07_arg_true "$FIELD" "signet_only: signet_only_for(identifier, true),"
refuse "$H" N07_arg_not_mobile "$FIELD" "signet_only: signet_only_for(identifier, !mobile),"
refuse "$H" N07_arg_literal "$FIELD" 'signet_only: signet_only_for("tech.mindlink.bitsov.beta", mobile),'
refuse "$H" N07_extra_arg "$FIELD" "signet_only: signet_only_for(identifier, mobile, mobile),"
refuse "$H" N08_prefixed_name "$FIELD" "signet_only: other_signet_only_for(identifier, mobile),"
refuse "$H" N08_qualified_name "$FIELD" "signet_only: other::signet_only_for(identifier, mobile),"
refuse "$H" N08_field_name "$FIELD" "not_signet_only: signet_only_for(identifier, mobile),$NL            signet_only: false,"
refuse "$H" N09_field_false "$FIELD" "signet_only: false,"
refuse "$H" N09_field_removed "$FIELD" ""
refuse "$H" N09_field_shorthand "$FIELD" "signet_only,"

# N10-N12: the helper body must be exactly `mobile || matches!(...)`.
refuse "$H" N10_no_beta "$BODY" "mobile || matches!(identifier, REMOTE_TEST_IDENTIFIER)"
refuse "$H" N10_no_remote "$BODY" "mobile || matches!(identifier, BETA_IDENTIFIER)"
refuse "$H" N11_and "$BODY" "mobile && $IDS"
refuse "$H" N11_mobile_only "$BODY" "mobile"
refuse "$H" N11_false "$BODY" "false"
refuse "$H" N11_suffix_mobile "$BODY" "$BODY && mobile"
refuse "$H" N11_suffix_false "$BODY" "$BODY && false"
refuse "$H" N12_let_shadow "$BODY" "let mobile = false;$NL    $BODY"
refuse "$H" N12_let_identifier "$BODY" "let identifier = \"\";$NL    $BODY"
refuse "$H" N12_early_return "$BODY" "return false;$NL    $BODY"
refuse "$H" N12_local_helper "$BODY" "fn signet_only_for(_: &str, _: bool) -> bool { false }$NL    $BODY"
refuse "$H" N12_ctor_let "$CTOR" "$CTOR$NL        let mobile = false;"

# N13-N15: the inline field must be exactly the matches! form.
refuse "$I" N13_inline_suffix_mobile "$IFIELD" "signet_only: $IDS && mobile,"
refuse "$I" N13_inline_suffix_false "$IFIELD" "signet_only: $IDS && false,"
refuse "$I" N13_inline_not "$IFIELD" "signet_only: !$IDS,"
refuse "$I" N14_inline_parens "$IFIELD" "signet_only: ($IDS),"
refuse "$I" N14_inline_block "$IFIELD" "signet_only: { $IDS; false },"
refuse "$I" N14_inline_false_or "$IFIELD" "signet_only: false || $IDS,"
refuse "$I" N15_inline_no_remote "$IFIELD" "signet_only: matches!(identifier, BETA_IDENTIFIER),"
refuse "$I" N15_inline_no_beta "$IFIELD" "signet_only: matches!(identifier, REMOTE_TEST_IDENTIFIER),"
refuse "$I" N15_inline_extra_pattern "$IFIELD" 'signet_only: matches!(identifier, BETA_IDENTIFIER | REMOTE_TEST_IDENTIFIER | "tech.mindlink.bitsov"),'
refuse "$I" N15_inline_scrutinee "$IFIELD" 'signet_only: matches!("tech.mindlink.bitsov.beta", BETA_IDENTIFIER | REMOTE_TEST_IDENTIFIER),'

# N16-N18: comments and literals never supply the policy.
refuse "$H" N16_line_comment_field "$FIELD" "signet_only: false,$NL            // $FIELD"
refuse "$I" N16_line_comment_inline "$IFIELD" "signet_only: false, // $IFIELD"
refuse "$H" N16_line_comment_helper "$HELPER" "// $GOODHELPER$NL${SIG}$NL    false$NL}"
refuse "$H" N17_block_comment "$FIELD" "signet_only: false, /* $FIELD */"
refuse "$H" N17_nested_comment "$FIELD" "signet_only: /* /* */ signet_only_for(identifier, mobile), */ false,"
refuse "$H" N17_doc_comments "$HELPER" "/// $GOODHELPER$NL/** $GOODHELPER */$NL${SIG}$NL    mobile$NL}"
refuse "$H" N18_string "$BODY" "mobile" "$FIELD" "signet_only: false," "$IMPL" "const _DECOY: &str = \"$FIELD $GOODHELPER\";$NL$IMPL"
refuse "$H" N18_escaped_string "$BODY" "mobile" "$FIELD" "signet_only: false," "$IMPL" 'const _DECOY: &str = "\" \\ '"$FIELD $GOODHELPER"'";'"$NL$IMPL"
refuse "$H" N18_raw_string "$BODY" "mobile" "$FIELD" "signet_only: false," "$IMPL" "const _DECOY: &str = r#\"say \"hi\" $FIELD $GOODHELPER\"#;$NL$IMPL"
refuse "$H" N18_byte_string "$BODY" "mobile" "$FIELD" "signet_only: false," "$IMPL" "const _DECOY: &[u8] = b\"$FIELD $GOODHELPER\";$NL$IMPL"

# N19-N20: copies outside the production items, a shadowed matches!, conditional or
# duplicate policy items.
refuse "$H" N19_test_module_helper "$BODY" "mobile" "$IMPL" "#[cfg(test)]${NL}mod decoy {$NL    $GOODHELPER$NL}$NL$IMPL"
refuse "$H" N19_unused_constructor "$FIELD" "signet_only: false," "$IMPL" "fn _unused(identifier: &str, mobile: bool) -> AppProfile {$NL    AppProfile { remote_only: false, $FIELD beta_storage: false }$NL}$NL$IMPL"
refuse "$H" N19_other_impl "$FIELD" "signet_only: false," "$IMPL" "mod decoy {$NL    use super::*;$NL    impl AppProfile {$NL        fn _x(identifier: &str, mobile: bool) -> Self { Self { remote_only: false, $FIELD beta_storage: false } }$NL    }$NL}$NL$IMPL"
refuse "$H" N19_macro_tokens "$FIELD" "signet_only: false," "$IMPL" "macro_rules! decoy { () => { $FIELD } }$NL$IMPL"
refuse "$H" N19_shadow_matches "$IMPL" "macro_rules! matches { (\$(\$t:tt)*) => { false } }$NL$IMPL"
refuse "$H" N19_import_matches "$IMPL" "use crate::matches;$NL$IMPL"
refuse "$H" N19_glob_import "$IMPL" "use crate::*;$NL$IMPL"
refuse "$H" N19_macro_use "$IMPL" "#[macro_use]${NL}mod m {}$NL$IMPL"
refuse "$H" N20_cfg_helpers "$HELPER" "#[cfg(not(windows))]$NL$GOODHELPER$NL#[cfg(windows)]$NL${SIG}$NL    mobile$NL}"
refuse "$H" N20_cfg_helper "$HELPER" "#[cfg(not(windows))]$NL$HELPER"
refuse "$H" N20_cfg_impl "$IMPL" "#[cfg(not(windows))]$NL$IMPL"
refuse "$H" N20_duplicate_impl "$IMPL" "impl AppProfile {}$NL$IMPL"
refuse "$H" N20_cfg_constructors "$CTOR" "#[cfg(windows)]$NL    pub(crate) fn for_platform(identifier: &str, mobile: bool) -> Self { $OFF }$NL    #[cfg(not(windows))]$NL    $CTOR"

# N21-N22: the constructor returns the approved struct, and production uses it.
refuse "$H" N21_early_return "$CTOR" "$CTOR$NL        return $OFF;"
refuse "$H" N21_reassigned "$CTOR" "$CTOR$NL        let mut profile =" "$CTOR_END" "$CTOR_END;$NL        profile.signet_only = false;$NL        profile"
refuse "$H" N21_struct_update "$CTOR_END" "beta_storage: identifier == BETA_IDENTIFIER,$NL            ..Self::for_identifier(\"\")$NL        }"
refuse "$H" N22_forwarder_bypass "$FWD" "$OFF"
refuse "$H" N22_forwarder_identifier "$FWD" 'Self::for_platform("tech.mindlink.bitsov", false)'

# N23: the identifiers come from the one real top-level declaration.
mutate "$H" N23_beta_in_comment "$BETA_DECL" "// $BETA_DECL"; both 3 "no longer defines BETA_IDENTIFIER"
mutate "$H" N23_remote_in_raw_string "$REMOTE_DECL" "const _DECOY: &str = r#\"$REMOTE_DECL\"#;"; both 3 "no longer defines REMOTE_TEST_IDENTIFIER"
mutate "$H" N23_beta_in_test_module "$BETA_DECL" "#[cfg(test)]${NL}mod decoy {$NL    $BETA_DECL$NL}"; both 3 "no longer defines BETA_IDENTIFIER"
mutate "$H" N23_duplicate_beta "$BETA_DECL" "$BETA_DECL$NL$BETA_DECL"; both 3 "no longer defines BETA_IDENTIFIER"
mutate "$H" N23_beta_unsupported "$BETA_DECL" "const BETA_IDENTIFIER: &str = concat!(\"tech.mindlink.bitsov\", \".beta\");$NL// $BETA_DECL"; both 3 "no longer defines BETA_IDENTIFIER"
mutate "$H" N23_beta_escaped "$BETA_DECL" 'const BETA_IDENTIFIER: &str = "tech.mindlink.bitsov\x2ebeta";'; both 3 "no longer defines BETA_IDENTIFIER"
mutate "$H" N23_local_const_shadow "$BODY" "$BETA_DECL$NL    $BODY"; both 3 "no longer defines BETA_IDENTIFIER"
# A different well-formed identifier is an identity change, not a policy refusal.
mutate "$H" N23_beta_renamed "$BETA_DECL" 'const BETA_IDENTIFIER: &str = "tech.mindlink.bitsov.beta2";'
run 3 "is not signet-only" --out "$T/out" --runner xwin --source-sha "$SHA" --check-only
run 0 "check only: nothing built" --out "$T/out" --runner xwin --source-sha "$SHA" --check-only --overlay "$REMOTE"

# N24: anything that cannot be read safely refuses.
refuse "$H" N24_no_delimiter "$FIELD" "signet_only: signet_only_for(identifier, mobile)"
refuse "$H" N24_duplicate_field "$FIELD" "$FIELD$NL            $FIELD"
refuse "$H" N24_unbalanced_brace "$BODY" "{ $BODY"
refuse "$H" N24_unbalanced_paren "$BODY" "$BODY)"
refuse "$H" N24_open_comment "$BETA_DECL" "/* $BETA_DECL"
refuse "$H" N24_open_raw_string "$IMPL" "const _X: &str = r#\"abc\";$NL$IMPL"
refuse "$H" N24_open_char "$IMPL" "const _X: char = '\\u{7d;$NL$IMPL"

# N25: a mutation that does not apply, or would hit the wrong occurrence, fails the suite.
for n25 in "absent:no such fragment" "ambiguous:signet_only_for(identifier"; do
  before=$FAILS
  mutate "$H" "N25_${n25%%:*}" "${n25#*:}" "x" >/dev/null 2>&1
  if [ "$FAILS" = $((before + 1)) ] && cmp -s "$H" "$PROFILE"; then
    FAILS=$before; echo "ok: N25_${n25%%:*} mutation rejected"
  else
    echo "FAIL: N25_${n25%%:*}: an unapplied mutation was not reported"; FAILS=$((before + 1))
  fi
done
CASE=""
cp "$H" "$PROFILE"

# Arguments.
run 2 "--out <dir> is required" --runner xwin --source-sha "$SHA" --check-only
run 2 "pass --source-sha" --out "$T/out" --runner xwin --check-only
run 2 "40 lowercase hex" --out "$T/out" --runner xwin --source-sha ABC --check-only
run 2 "--runner must be" --out "$T/out" --runner docker --source-sha "$SHA" --check-only

# No download without --allow-downloads.
EMPTY="$T/cache/empty"; mkdir -p "$EMPTY"
XWIN="$EMPTY"
run 5 "MSVC CRT and Windows SDK" --out "$T/out" --runner xwin --source-sha "$SHA" --check-only
run 0 "allowed download: cargo-xwin would download" --out "$T/out" --runner xwin --source-sha "$SHA" --check-only --allow-downloads
# A cache folder with content but no completion marker is not a cache cargo-xwin reuses.
CASE="xwin cache without DONE"; XWIN="$T/cache/xwin-partial"; mkdir -p "$XWIN/crt" "$XWIN/xwin/sdk"
run 5 "xwin/DONE does not list it" --out "$T/out" --runner xwin --source-sha "$SHA" --check-only
CASE="empty xwin DONE"; : > "$XWIN/xwin/DONE"
run 5 "xwin/DONE does not list it" --out "$T/out" --runner xwin --source-sha "$SHA" --check-only
# cargo-xwin reads the requested architectures from the marker's first line: anything without x86_64 is refetched.
for marker in 'done' aarch64 'aarch64 arm' 'x86 64' 'sdk/include'; do
  CASE="xwin DONE first line: $marker"; printf '%s\nsdk/include\n' "$marker" > "$XWIN/xwin/DONE"
  run 5 "xwin/DONE does not list it" --out "$T/out" --runner xwin --source-sha "$SHA" --check-only
done
CASE="xwin DONE lists x86_64 on line 2 only"; printf 'aarch64\nx86_64\n' > "$XWIN/xwin/DONE"
run 5 "xwin/DONE does not list it" --out "$T/out" --runner xwin --source-sha "$SHA" --check-only
CASE="xwin DONE with invalid UTF-8 on a later line"; printf 'x86_64\nsdk/\377\n' > "$XWIN/xwin/DONE"
run 5 "xwin/DONE does not list it" --out "$T/out" --runner xwin --source-sha "$SHA" --check-only
CASE="xwin DONE with invalid UTF-8 on the first line"; printf 'x86_64 \377\n' > "$XWIN/xwin/DONE"
run 5 "xwin/DONE does not list it" --out "$T/out" --runner xwin --source-sha "$SHA" --check-only
CASE="xwin DONE with valid non-ASCII UTF-8 on a later line"; printf 'x86_64\nsdk/\303\251\n' > "$XWIN/xwin/DONE"
run 0 "check only: nothing built" --out "$T/out" --runner xwin --source-sha "$SHA" --check-only
CASE="xwin DONE with both arches"; printf 'aarch64 x86_64\n' > "$XWIN/xwin/DONE"
run 0 "check only: nothing built" --out "$T/out" --runner xwin --source-sha "$SHA" --check-only
CASE=""; XWIN="$T/cache/xwin"
HOMEDIR="$T/home-empty"; mkdir -p "$HOMEDIR"
run 5 "NSIS tools" --out "$T/out" --runner xwin --source-sha "$SHA" --check-only
# Empty Plugins/crt folders (or any other partial cache) do not pass.
CASE="NSIS Plugins folder only"; HOMEDIR="$T/home-plugins"; mkdir -p "$(nsis_dir "$HOMEDIR")/Plugins/x86-unicode/additional"
run 5 "missing or mismatched files" --out "$T/out" --runner xwin --source-sha "$SHA" --check-only
CASE="NSIS plugin with other bytes"; printf 'altered\n' > "$(nsis_dir "$HOMEDIR")/Plugins/x86-unicode/additional/nsis_tauri_utils.dll"
run 5 "missing or mismatched files" --out "$T/out" --runner xwin --source-sha "$SHA" --check-only
run 0 "allowed download: the Tauri bundler" --out "$T/out" --runner xwin --source-sha "$SHA" --check-only --allow-downloads
CASE="old BITSOV_TAURI_NSIS_CACHE is ignored"
out="$(env PATH="$SAFE_PATH" HOME="$HOMEDIR" XDG_CACHE_HOME="$HOMEDIR/.cache" XWIN_CACHE_DIR="$XWIN" XWIN_SDK_VERSION="$SDKV" XWIN_CRT_VERSION="$CRTV" \
  BITSOV_TAURI_NSIS_CACHE="$(nsis_dir "$T/home-full")" bash "$SCRIPT" --out "$T/out" --runner xwin --source-sha "$SHA" --check-only 2>&1)" && got=0 || got=$?
if [ "$got" = 5 ]; then echo "ok: $CASE: exit 5"; else echo "FAIL: $CASE: exit $got (want 5)"; echo "$out"; FAILS=$((FAILS + 1)); fi
CASE=""; HOMEDIR="$T/home-full"
# SDK and CRT versions are explicit, never cargo-xwin's latest.
CASE="no SDK version"; SDKV=""
run 4 "XWIN_SDK_VERSION" --out "$T/out" --runner xwin --source-sha "$SHA" --check-only --allow-downloads
CASE="no CRT version"; SDKV=10.0.22621; CRTV=""
run 4 "XWIN_CRT_VERSION" --out "$T/out" --runner xwin --source-sha "$SHA" --check-only --allow-downloads
CASE=""; CRTV=14.40
# The NSIS check is written for one Tauri CLI version.
CASE="other Tauri CLI in the lockfile"; cp "$T/root/package-lock.json" "$T/lock.keep"
node -e 'const fs=require("fs");const l=JSON.parse(fs.readFileSync(process.argv[1]));l.packages["node_modules/@tauri-apps/cli"].version="2.13.0";fs.writeFileSync(process.argv[1],JSON.stringify(l));' "$T/root/package-lock.json"
run 2 "NSIS cache check is written for 2.12.0" --out "$T/out" --runner xwin --source-sha "$SHA" --check-only
mv "$T/lock.keep" "$T/root/package-lock.json"; CASE=""
# The lockfile is right but node_modules holds another Tauri CLI: refused before any build.
CASE="installed Tauri CLI 2.9.0"; tauri_stub 2.9.0
run 2 "a Tauri CLI other than 2.12.0" --out "$T/out" --runner xwin --source-sha "$SHA" --check-only
run 2 "a Tauri CLI other than 2.12.0" --out "$T/out" --runner xwin --source-sha "$SHA" --check-only --allow-downloads
CASE="installed Tauri CLI with no version"; printf '#!/bin/sh\nexit 0\n' > "$T/root/node_modules/.bin/tauri"; chmod +x "$T/root/node_modules/.bin/tauri"
run 2 "a Tauri CLI other than 2.12.0" --out "$T/out" --runner xwin --source-sha "$SHA" --check-only
CASE=""; tauri_stub 2.12.0
rm "$T/root/node_modules/.bin/tauri"
run 5 "npm ci would download" --out "$T/out" --runner xwin --source-sha "$SHA" --check-only
run 0 "allowed download: npm ci" --out "$T/out" --runner xwin --source-sha "$SHA" --check-only --allow-downloads

# Missing host tools are reported, never installed.
rm "$T/bin/makensis"
run 4 "makensis" --out "$T/out" --runner xwin --source-sha "$SHA" --check-only --allow-downloads
printf '#!/bin/sh\nexit 0\n' > "$T/bin/makensis"; chmod +x "$T/bin/makensis"
printf '#!/bin/sh\necho aarch64-apple-darwin\n' > "$T/bin/rustup"
run 4 "rustup target x86_64-pc-windows-msvc" --out "$T/out" --runner xwin --source-sha "$SHA" --check-only

[ ! -e "$T/out" ] || { echo "FAIL: --check-only created the output dir"; FAILS=$((FAILS + 1)); }
if [ "$FAILS" != 0 ]; then echo "$FAILS failure(s)"; exit 1; fi
echo "all build-windows-remote guard tests passed"
