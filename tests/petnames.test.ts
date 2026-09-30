import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearVerified,
  dismissKeyWarning,
  formatNodeFingerprint,
  fingerprintQrPayload,
  markVerified,
  petnameOf,
  plantVerifiedKeyForTests,
  reconcileKeyChange,
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

  it('drops verified and warns when the stored key no longer matches', () => {
    plantVerifiedKeyForTests(A, B);
    expect(verifyState(A)).toBe('key-changed');
    expect(reconcileKeyChange(A)).toBe('key-changed');
    expect(verifyState(A)).toBe('key-changed');
    dismissKeyWarning(A);
    expect(verifyState(A)).toBe('unverified');
  });

  it('formats a grouped hex fingerprint and a bare hex QR payload', () => {
    expect(shortFingerprint(A)).toBe('aaaa · aaaa · aaaa · aaaa');
    expect(formatNodeFingerprint(A).startsWith('aaaa · aaaa')).toBe(true);
    expect(formatNodeFingerprint(A).split(' · ')).toHaveLength(16);
    expect(fingerprintQrPayload(A)).toBe(A);
    // Authority: no http(s) scheme in renderer payloads.
    expect(fingerprintQrPayload(A)).not.toMatch(/^https?:/i);
  });
});
