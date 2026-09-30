import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearVerified,
  dismissKeyWarning,
  formatNodeFingerprint,
  fingerprintQrPayload,
  markVerified,
  petnameOf,
  reloadContactsFromStorageForTests,
  replaceContactKey,
  resetContactsForTests,
  setPetname,
  shortFingerprint,
  verifyState,
} from '../src/control/petnames';
import { claimedName, peerName } from '../src/control/state';
import { shortId } from '../src/control/format';
import type { Peer } from '../src/control/types';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);

beforeEach(() => resetContactsForTests());
afterEach(() => resetContactsForTests());

describe('petnames', () => {
  it('stores a local petname and never uses peer.label as the display name', () => {
    const peer: Peer = { node_id: A, addr: null, label: 'RemoteClaim', connected: true, fingerprint: 'aaaaaaaa' };
    expect(peerName(peer, A)).toBe(shortId(A));
    expect(claimedName(peer)).toBe('RemoteClaim');
    setPetname(A, '  Maya  ');
    expect(petnameOf(A)).toBe('Maya');
    expect(peerName(peer, A)).toBe('Maya');
  });

  it('clears a petname when set empty', () => {
    setPetname(A, 'Maya');
    setPetname(A, '   ');
    expect(petnameOf(A)).toBeNull();
  });

  it('marks verified against the current node key', () => {
    expect(verifyState(A)).toBe('unverified');
    markVerified(A);
    expect(verifyState(A)).toBe('verified');
    clearVerified(A);
    expect(verifyState(A)).toBe('unverified');
  });

  it('owner-confirmed key replacement clears verified, keeps petname, and warns until dismiss', () => {
    setPetname(A, 'Maya');
    markVerified(A);
    expect(verifyState(A)).toBe('verified');

    expect(replaceContactKey(A, B)).toBe(true);
    expect(petnameOf(A)).toBeNull();
    expect(petnameOf(B)).toBe('Maya');
    expect(verifyState(B)).toBe('key-changed');
    expect(verifyState(A)).toBe('unverified');

    // Durable across a storage reload (new process / reopen).
    reloadContactsFromStorageForTests();
    expect(petnameOf(B)).toBe('Maya');
    expect(verifyState(B)).toBe('key-changed');

    dismissKeyWarning(B);
    expect(verifyState(B)).toBe('unverified');
    expect(petnameOf(B)).toBe('Maya');
  });

  it('re-verify after replacement clears the warning', () => {
    setPetname(A, 'Maya');
    markVerified(A);
    expect(replaceContactKey(A, B)).toBe(true);
    expect(verifyState(B)).toBe('key-changed');
    markVerified(B);
    expect(verifyState(B)).toBe('verified');
  });

  it('refuses replacement when the new key already belongs to another contact', () => {
    setPetname(A, 'Maya');
    markVerified(A);
    setPetname(B, 'Other');
    expect(replaceContactKey(A, B)).toBe(false);
    expect(verifyState(A)).toBe('verified');
    expect(petnameOf(B)).toBe('Other');
  });

  it('does not infer sameness: a new key alone is a different contact', () => {
    setPetname(A, 'Maya');
    markVerified(A);
    // B appears with the same claimed label — still unrelated until replaceContactKey.
    const peerB: Peer = { node_id: B, addr: null, label: 'Maya', connected: true, fingerprint: null };
    expect(peerName(peerB, B)).toBe(shortId(B));
    expect(verifyState(B)).toBe('unverified');
    expect(verifyState(A)).toBe('verified');
  });

  it('formats a grouped hex fingerprint and a bare hex QR payload', () => {
    expect(shortFingerprint(A)).toBe('aaaa · aaaa · aaaa · aaaa');
    expect(formatNodeFingerprint(A).startsWith('aaaa · aaaa')).toBe(true);
    expect(formatNodeFingerprint(A).split(' · ')).toHaveLength(16);
    expect(fingerprintQrPayload(A)).toBe(A);
    expect(fingerprintQrPayload(A)).not.toMatch(/^https?:/i);
  });

  it('replaceContactKey rejects identical or unknown keys', () => {
    expect(replaceContactKey(A, A)).toBe(false);
    expect(replaceContactKey(A, B)).toBe(false);
    markVerified(A);
    expect(replaceContactKey(A, 'not-a-key')).toBe(false);
    expect(replaceContactKey(C, B)).toBe(false);
  });
});
