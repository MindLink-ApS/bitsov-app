/**
 * Local petnames and fingerprint verification (ACCOUNT-LAYER §6).
 *
 * A petname is the name *you* give a contact. It never leaves this device /
 * renderer. A peer's `label` or front-door `display_name` is only a suggestion
 * (self-claimed). Verified means you compared fingerprints out-of-band.
 *
 * Contacts have a stable local id and a current node key. When the owner
 * confirms a key replacement, verification clears and a durable warning is
 * kept. Sameness is never inferred from a claimed name or address.
 */

import { createRoot, createSignal } from 'solid-js';

const STORE_KEY = 'bitsov.contacts.v2';
const STORE_KEY_V1 = 'bitsov.contacts.v1';

export type ContactLocal = {
  /** Stable local identity (not the node key). */
  id: string;
  /** Current node key (64 hex). */
  nodeKey: string;
  /** Owner-chosen name. Never published. */
  petname?: string;
  /** Node key hex at the moment of Verify (equals nodeKey while verified). */
  verifiedKey?: string;
  /** Unix ms when Verify was confirmed. */
  verifiedAt?: number;
  /** Set after an owner-confirmed key replacement until dismiss or re-verify. */
  keyChanged?: boolean;
};

export type VerifyState = 'unverified' | 'verified' | 'key-changed';

type Store = { byId: Record<string, ContactLocal> };

function normId(nodeId: string): string {
  return nodeId.trim().toLowerCase();
}

function isNodeKey(hex: string): boolean {
  return /^[0-9a-f]{64}$/.test(hex);
}

function newContactId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    /* ignore */
  }
  return `c-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

function emptyStore(): Store {
  return { byId: {} };
}

function migrateV1(raw: unknown): Store {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyStore();
  const out = emptyStore();
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    const row = v as Record<string, unknown>;
    const nodeKey = normId(k);
    if (!isNodeKey(nodeKey)) continue;
    const entry: ContactLocal = { id: newContactId(), nodeKey };
    if (typeof row.petname === 'string' && row.petname.trim()) entry.petname = row.petname.trim();
    if (typeof row.verifiedKey === 'string' && row.verifiedKey) entry.verifiedKey = row.verifiedKey.toLowerCase();
    if (typeof row.verifiedAt === 'number' && Number.isFinite(row.verifiedAt)) entry.verifiedAt = row.verifiedAt;
    if (row.keyChanged === true) entry.keyChanged = true;
    if (entry.petname || entry.verifiedKey || entry.keyChanged) out.byId[entry.id] = entry;
  }
  return out;
}

function parseStore(raw: string | null): Store {
  if (!raw) return emptyStore();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyStore();
    const obj = parsed as Record<string, unknown>;
    if (obj.v === 2 && obj.byId && typeof obj.byId === 'object' && !Array.isArray(obj.byId)) {
      const out = emptyStore();
      for (const [id, v] of Object.entries(obj.byId as Record<string, unknown>)) {
        if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
        const row = v as Record<string, unknown>;
        const nodeKey = typeof row.nodeKey === 'string' ? normId(row.nodeKey) : '';
        if (!isNodeKey(nodeKey)) continue;
        const entry: ContactLocal = { id: typeof row.id === 'string' && row.id ? row.id : id, nodeKey };
        if (typeof row.petname === 'string' && row.petname.trim()) entry.petname = row.petname.trim();
        if (typeof row.verifiedKey === 'string' && row.verifiedKey) entry.verifiedKey = row.verifiedKey.toLowerCase();
        if (typeof row.verifiedAt === 'number' && Number.isFinite(row.verifiedAt)) entry.verifiedAt = row.verifiedAt;
        if (row.keyChanged === true) entry.keyChanged = true;
        out.byId[entry.id] = entry;
      }
      return out;
    }
    // Legacy v1: map keyed by node id.
    return migrateV1(parsed);
  } catch {
    return emptyStore();
  }
}

function readStore(): Store {
  try {
    const v2 = localStorage.getItem(STORE_KEY);
    if (v2) return parseStore(v2);
    const v1 = localStorage.getItem(STORE_KEY_V1);
    if (v1) {
      const migrated = parseStore(v1);
      // Only drop v1 after v2 is durable. A failed write (quota, private mode)
      // must leave v1 so the next startup can retry migration.
      if (writeStore(migrated)) {
        try {
          localStorage.removeItem(STORE_KEY_V1);
        } catch {
          /* ignore */
        }
      }
      return migrated;
    }
  } catch {
    /* private mode */
  }
  return emptyStore();
}

/** Persist v2. Returns false when storage refused the write (e.g. QuotaExceededError). */
function writeStore(store: Store): boolean {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ v: 2, byId: store.byId }));
    return true;
  } catch {
    return false;
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

function findByNodeKey(nodeKey: string): ContactLocal | undefined {
  const key = normId(nodeKey);
  for (const c of Object.values(store().byId)) {
    if (c.nodeKey === key) return c;
  }
  return undefined;
}

function isEmptyContact(c: ContactLocal): boolean {
  return !c.petname && !c.verifiedKey && !c.keyChanged;
}

function putContact(next: Store, c: ContactLocal) {
  if (isEmptyContact(c)) delete next.byId[c.id];
  else next.byId[c.id] = c;
}

export function getContact(nodeId: string): ContactLocal {
  contactRevision();
  return findByNodeKey(nodeId) ?? { id: '', nodeKey: normId(nodeId) };
}

/** Owner petname for the contact that currently holds this node key, or null. */
export function petnameOf(nodeId: string): string | null {
  const n = getContact(nodeId).petname?.trim();
  return n || null;
}

/**
 * Set or clear the local petname for the contact at this node key.
 * Empty / whitespace clears it. Never syncs to the node or the peer.
 */
export function setPetname(nodeId: string, name: string | null | undefined) {
  const key = normId(nodeId);
  if (!isNodeKey(key)) return;
  const next = { byId: { ...store().byId } };
  let cur = findByNodeKey(key);
  if (!cur) {
    cur = { id: newContactId(), nodeKey: key };
  } else {
    cur = { ...cur };
  }
  const trimmed = (name ?? '').trim();
  if (trimmed) cur.petname = trimmed;
  else delete cur.petname;
  putContact(next, cur);
  bump(next);
}

/** Seed a sample/demo petname only when none is set yet. */
export function seedPetnameIfEmpty(nodeId: string, name: string) {
  const key = normId(nodeId);
  if (findByNodeKey(key)?.petname?.trim()) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  setPetname(key, trimmed);
}

/** Mark this node key verified after an out-of-band fingerprint compare. */
export function markVerified(nodeId: string, atMs = Date.now()) {
  const key = normId(nodeId);
  if (!isNodeKey(key)) return;
  const next = { byId: { ...store().byId } };
  let cur = findByNodeKey(key);
  if (!cur) cur = { id: newContactId(), nodeKey: key };
  else cur = { ...cur };
  cur.nodeKey = key;
  cur.verifiedKey = key;
  cur.verifiedAt = atMs;
  delete cur.keyChanged;
  next.byId[cur.id] = cur;
  bump(next);
}

export function clearVerified(nodeId: string) {
  const key = normId(nodeId);
  const cur = findByNodeKey(key);
  if (!cur?.verifiedKey && !cur?.keyChanged) return;
  const next = { byId: { ...store().byId } };
  const copy = { ...cur };
  delete copy.verifiedKey;
  delete copy.verifiedAt;
  delete copy.keyChanged;
  putContact(next, copy);
  bump(next);
}

/** Clear the key-changed warning after the owner has seen it (without re-verify). */
export function dismissKeyWarning(nodeId: string) {
  const key = normId(nodeId);
  const cur = findByNodeKey(key);
  if (!cur?.keyChanged) return;
  const next = { byId: { ...store().byId } };
  const copy = { ...cur };
  delete copy.keyChanged;
  putContact(next, copy);
  bump(next);
}

/**
 * Owner-confirmed key replacement: the same local contact now uses `toNodeKey`.
 * Clears verified and persists a key-changed warning. Never call this because
 * two peers share a claimed name or address — only after an explicit owner act.
 *
 * @returns false when keys are invalid, identical, unknown, or `to` is already another contact.
 */
export function replaceContactKey(fromNodeKey: string, toNodeKey: string): boolean {
  const from = normId(fromNodeKey);
  const to = normId(toNodeKey);
  if (!isNodeKey(from) || !isNodeKey(to) || from === to) return false;
  const cur = findByNodeKey(from);
  if (!cur) return false;
  const conflict = findByNodeKey(to);
  if (conflict && conflict.id !== cur.id) return false;
  const next = { byId: { ...store().byId } };
  const copy: ContactLocal = { ...cur, nodeKey: to, keyChanged: true };
  delete copy.verifiedKey;
  delete copy.verifiedAt;
  next.byId[copy.id] = copy;
  bump(next);
  return true;
}

/**
 * Verification against the contact's current node key.
 * `key-changed` means the owner linked a replacement key after a prior verify.
 */
export function verifyState(nodeId: string): VerifyState {
  const key = normId(nodeId);
  const c = findByNodeKey(key);
  if (!c) return 'unverified';
  contactRevision();
  if (c.keyChanged) return 'key-changed';
  if (!c.verifiedKey) return 'unverified';
  if (c.verifiedKey !== c.nodeKey) return 'key-changed';
  return 'verified';
}

/**
 * Safety net: if verifiedKey drifts from nodeKey without going through
 * replaceContactKey, drop verified and keep the warning.
 */
export function reconcileKeyChange(nodeId: string): VerifyState {
  const key = normId(nodeId);
  const c = findByNodeKey(key);
  if (!c) return 'unverified';
  if (c.verifiedKey && c.verifiedKey !== c.nodeKey) {
    const next = { byId: { ...store().byId } };
    const copy: ContactLocal = { ...c, keyChanged: true };
    delete copy.verifiedKey;
    delete copy.verifiedAt;
    next.byId[copy.id] = copy;
    bump(next);
    return 'key-changed';
  }
  return verifyState(key);
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
    localStorage.removeItem(STORE_KEY_V1);
  } catch {
    /* ignore */
  }
  bump(emptyStore());
}

/** Test helper: re-read durable store as after a process restart. */
export function reloadContactsFromStorageForTests() {
  bump(readStore());
}
