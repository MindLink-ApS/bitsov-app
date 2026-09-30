/**
 * Local petnames and fingerprint verification (ACCOUNT-LAYER §6).
 *
 * A petname is the name *you* give a contact. It never leaves this device /
 * renderer. A peer's `label` or front-door `display_name` is only a suggestion
 * (self-claimed). Verified means you compared fingerprints out-of-band; if the
 * node key ever changes, verified drops and a warning is shown.
 */

import { createRoot, createSignal } from 'solid-js';

const STORE_KEY = 'bitsov.contacts.v1';

export type ContactLocal = {
  /** Owner-chosen name. Never published. */
  petname?: string;
  /** Lowercase node_id hex at the moment of Verify. */
  verifiedKey?: string;
  /** Unix ms when Verify was confirmed. */
  verifiedAt?: number;
  /** Prior verified key no longer matches this contact's node id. */
  keyChanged?: boolean;
};

export type VerifyState = 'unverified' | 'verified' | 'key-changed';

type Store = Record<string, ContactLocal>;

function normId(nodeId: string): string {
  return nodeId.trim().toLowerCase();
}

function readStore(): Store {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Store = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
      const row = v as Record<string, unknown>;
      const entry: ContactLocal = {};
      if (typeof row.petname === 'string' && row.petname.trim()) entry.petname = row.petname.trim();
      if (typeof row.verifiedKey === 'string' && row.verifiedKey) entry.verifiedKey = row.verifiedKey.toLowerCase();
      if (typeof row.verifiedAt === 'number' && Number.isFinite(row.verifiedAt)) entry.verifiedAt = row.verifiedAt;
      if (row.keyChanged === true) entry.keyChanged = true;
      if (entry.petname || entry.verifiedKey || entry.keyChanged) out[normId(k)] = entry;
    }
    return out;
  } catch {
    return {};
  }
}

function writeStore(store: Store) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch {
    /* private mode / quota */
  }
}

let storeSignal: (() => Store) | null = null;
let setStoreSignal: ((v: Store) => void) | null = null;
let revSignal: (() => number) | null = null;
let setRevSignal: ((v: number) => void) | null = null;

createRoot(() => {
  const [store, setStore] = createSignal<Store>(readStore());
  const [rev, setRev] = createSignal(0);
  storeSignal = store;
  setStoreSignal = setStore;
  revSignal = rev;
  setRevSignal = setRev;
});

function bump(next: Store) {
  setStoreSignal?.(next);
  writeStore(next);
  setRevSignal?.((revSignal?.() ?? 0) + 1);
}

/** Solid dependency: call from display helpers so UI refreshes on rename/verify. */
export const contactRevision = (): number => revSignal?.() ?? 0;

function store(): Store {
  return storeSignal?.() ?? readStore();
}

export function getContact(nodeId: string): ContactLocal {
  contactRevision();
  return store()[normId(nodeId)] ?? {};
}

/** Owner petname, or null. */
export function petnameOf(nodeId: string): string | null {
  const n = getContact(nodeId).petname?.trim();
  return n || null;
}

/**
 * Set or clear the local petname. Empty / whitespace clears it.
 * Never syncs to the node or the peer.
 */
export function setPetname(nodeId: string, name: string | null | undefined) {
  const id = normId(nodeId);
  if (!id) return;
  const next = { ...store() };
  const cur = { ...(next[id] ?? {}) };
  const trimmed = (name ?? '').trim();
  if (trimmed) cur.petname = trimmed;
  else delete cur.petname;
  if (!cur.petname && !cur.verifiedKey && !cur.keyChanged) delete next[id];
  else next[id] = cur;
  bump(next);
}

/** Seed a sample/demo petname only when none is set yet. */
export function seedPetnameIfEmpty(nodeId: string, name: string) {
  const id = normId(nodeId);
  if (store()[id]?.petname?.trim()) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  setPetname(id, trimmed);
}

/** Mark this node key verified after an out-of-band fingerprint compare. */
export function markVerified(nodeId: string, atMs = Date.now()) {
  const id = normId(nodeId);
  if (!/^[0-9a-f]{64}$/.test(id)) return;
  const next = { ...store() };
  const cur = { ...(next[id] ?? {}) };
  cur.verifiedKey = id;
  cur.verifiedAt = atMs;
  delete cur.keyChanged;
  next[id] = cur;
  bump(next);
}

export function clearVerified(nodeId: string) {
  const id = normId(nodeId);
  const next = { ...store() };
  const cur = next[id];
  if (!cur?.verifiedKey && !cur?.keyChanged) return;
  const copy = { ...cur };
  delete copy.verifiedKey;
  delete copy.verifiedAt;
  delete copy.keyChanged;
  if (!copy.petname) delete next[id];
  else next[id] = copy;
  bump(next);
}

/** Clear the key-changed warning after the owner has seen it (without re-verify). */
export function dismissKeyWarning(nodeId: string) {
  const id = normId(nodeId);
  const next = { ...store() };
  const cur = next[id];
  if (!cur?.keyChanged) return;
  const copy = { ...cur };
  delete copy.keyChanged;
  if (!copy.petname && !copy.verifiedKey) delete next[id];
  else next[id] = copy;
  bump(next);
}

/**
 * Verification against the contact's current node key.
 * `key-changed` means we verified a different key earlier — drop trust UX.
 */
export function verifyState(nodeId: string): VerifyState {
  const id = normId(nodeId);
  const c = getContact(id);
  if (c.keyChanged) return 'key-changed';
  if (!c.verifiedKey) return 'unverified';
  if (c.verifiedKey !== id) return 'key-changed';
  return 'verified';
}

/**
 * If the stored verified key no longer matches this contact's node id, drop
 * verified and keep a durable warning until dismiss or re-verify.
 */
export function reconcileKeyChange(nodeId: string): VerifyState {
  const id = normId(nodeId);
  const c = getContact(id);
  if (c.verifiedKey && c.verifiedKey !== id) {
    const next = { ...store() };
    const copy: ContactLocal = { ...c, keyChanged: true };
    delete copy.verifiedKey;
    delete copy.verifiedAt;
    next[id] = copy;
    bump(next);
    return 'key-changed';
  }
  return verifyState(id);
}

/** Test/helper: plant a mismatched verified key under this contact id. */
export function plantVerifiedKeyForTests(nodeId: string, verifiedKey: string) {
  const id = normId(nodeId);
  const next = { ...store() };
  next[id] = { ...(next[id] ?? {}), verifiedKey: normId(verifiedKey), verifiedAt: Date.now() };
  delete next[id].keyChanged;
  bump(next);
}

/** Grouped hex of the node key for aloud / in-person compare (ACCOUNT-LAYER §6). */
export function formatNodeFingerprint(nodeId: string): string {
  const hex = normId(nodeId).replace(/[^0-9a-f]/g, '');
  if (!hex) return '';
  const parts: string[] = [];
  for (let i = 0; i < hex.length; i += 4) {
    parts.push(hex.slice(i, i + 4));
  }
  // Middle dots — avoid ordinary spaces so UI textContent stays unambiguous.
  return parts.join(' · ');
}

/** Short line: first four groups (16 hex chars). */
export function shortFingerprint(nodeId: string): string {
  return formatNodeFingerprint(nodeId).split(' · ').slice(0, 4).join(' · ');
}

/**
 * QR payload: the node id hex alone (no URL scheme — authority gate forbids
 * embedding http(s) in the renderer; a bare hex is the compare surface).
 */
export function fingerprintQrPayload(nodeId: string): string {
  return normId(nodeId);
}

/** Test helper: wipe local contact state. */
export function resetContactsForTests() {
  try {
    localStorage.removeItem(STORE_KEY);
  } catch {
    /* ignore */
  }
  bump({});
}
