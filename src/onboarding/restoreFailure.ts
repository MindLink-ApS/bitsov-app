/**
 * Which next step a failed identity restore needs.
 *
 * The host's `identity_restore` rejects with a plain string; there is no error code.
 * Only the host's own fixed forms are matched, anchored at the start, so arbitrary
 * node text that happens to mention "saved" or "mnemonic" is not misread.
 *
 * - `saved`: the host already saved the phrase, but restarting or confirming the
 *   identity failed. The phrase is fine; the user should quit and reopen.
 * - `phrase`: the host or node rejected the phrase itself (word count, invalid words).
 * - `other`: anything else (remote mode, bootstrap refusal, transport). Keep the
 *   plain fallback; do not guess.
 */
export type RestoreFailureKind = 'saved' | 'phrase' | 'other';

/** Shared start of the host's three post-save errors (src-tauri/src/app.rs, identity_restore). */
export const RESTORE_SAVED_PREFIX = 'the recovery phrase was saved, but ';
const HOST_WORD_COUNT = 'a recovery phrase is 12 or 24 words';
// The node answers 400 with "invalid mnemonic: …" or "mnemonic must be 12 or 24 words, got N".
const NODE_PHRASE_REJECTED = /^\/identity\/restore failed \(400\): (invalid mnemonic:|mnemonic must be 12 or 24 words\b)/;

export function restoreFailureKind(raw: string): RestoreFailureKind {
  const m = raw.trim().replace(/^Error:\s*/, '');
  if (m.startsWith(RESTORE_SAVED_PREFIX)) return 'saved';
  if (m === HOST_WORD_COUNT || NODE_PHRASE_REJECTED.test(m)) return 'phrase';
  return 'other';
}
