# J0 Phase 0.5 — evidence export, sourced by run-isolation-tests.sh and run-model-load.sh.
#
# The --evidence-dir belongs to the caller. These helpers never delete or overwrite anything
# in it that this run did not write:
#   evid_check DIR   at argument time, before anything is created: DIR must be absent or an
#                    empty real directory (not a symlink). Nothing is created or changed.
#   evid_export DIR RES MANIFEST
#                    called ONLY after a run completed (never from the EXIT trap, so an early
#                    exit or build failure leaves DIR untouched). Re-checks DIR, creates it if
#                    absent (parent must exist), writes each file exclusively (noclobber /
#                    O_EXCL) and records its name in MANIFEST (kept outside DIR). On any error
#                    it removes exactly the files named in MANIFEST, and DIR itself only if
#                    this call created it and it is empty again.

# Home directory, user name and private/link-local IPv4 addresses are redacted.
redact() {
  /usr/bin/perl -pe 'BEGIN{$h=shift @ARGV; $u=shift @ARGV}
    s/\Q$h\E/~/g; s#/Users/[^/\s]+#/Users/<user>#g; s/\Q$u\E/<user>/g;
    s/(?<![\d.])(?:10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])|192\.168|169\.254)\.\d{1,3}\.\d{1,3}(?![\d.])/<lan-ip>/g' \
    "$HOME" "$(id -un)" "$1"
}

evid_check() {  # $1 = evidence dir ("" = no export)
  local d=$1 c
  [ -n "$d" ] || return 0
  if [ -L "$d" ]; then echo "FATAL: evidence dir $d is a symlink; refusing" >&2; return 1; fi
  [ -e "$d" ] || return 0
  [ -d "$d" ] || { echo "FATAL: evidence dir $d is not a directory; refusing" >&2; return 1; }
  c=$(ls -A -- "$d") || { echo "FATAL: cannot list evidence dir $d; refusing" >&2; return 1; }
  [ -z "$c" ] || { echo "FATAL: evidence dir $d is not empty; refusing (pass a new or empty dir)" >&2; return 1; }
}

evid_export() {  # $1 = evidence dir, $2 = results dir, $3 = manifest path (outside $1)
  local d=$1 res=$2 man=$3 f n rc=0 created=0
  [ -n "$d" ] || return 0
  evid_check "$d" || return 1
  : > "$man" || return 1
  if [ ! -e "$d" ]; then mkdir -- "$d" || return 1; created=1; fi
  for f in "$res"/*; do
    [ -f "$f" ] || continue
    n=$(basename -- "$f")
    if ( set -C; : > "$d/$n" ) 2>/dev/null; then
      printf '%s\n' "$n" >> "$man"
      redact "$f" >> "$d/$n" || { rc=1; break; }
    else rc=1; break; fi
  done
  if [ "$rc" != 0 ]; then
    echo "evidence export failed; removing only the $(wc -l < "$man" | tr -d ' ') file(s) this run wrote" >&2
    while IFS= read -r n; do [ -n "$n" ] && rm -f -- "$d/$n"; done < "$man"
    [ "$created" = 1 ] && rmdir -- "$d" 2>/dev/null
    return 1
  fi
  echo "evidence: $(wc -l < "$man" | tr -d ' ') files exported to $d (manifest $man)"
}
