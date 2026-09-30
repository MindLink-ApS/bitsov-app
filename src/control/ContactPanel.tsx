/**
 * Contact sheet: local petname + fingerprint Verify (ACCOUNT-LAYER §6).
 * Petnames never leave the device. Peer labels / profile names are suggestions.
 */

import { createEffect, createMemo, createSignal, Show, type JSX } from 'solid-js';
import { qrSvg } from '../qr';
import { shortId } from './format';
import {
  clearVerified,
  dismissKeyWarning,
  formatNodeFingerprint,
  fingerprintQrPayload,
  markVerified,
  petnameOf,
  reconcileKeyChange,
  setPetname,
  shortFingerprint,
  verifyState,
  type VerifyState,
} from './petnames';
import { claimedName } from './state';
import type { Peer } from './types';

export function ContactPanel(props: {
  open: boolean;
  peer: Peer;
  /** Front-door display_name when the track was opened from a Knock. */
  doorName?: string | null;
  onClose: () => void;
}): JSX.Element {
  const id = () => props.peer.node_id;
  const [draft, setDraft] = createSignal('');
  const [confirming, setConfirming] = createSignal(false);

  createEffect(() => {
    if (!props.open) return;
    setDraft(petnameOf(id()) ?? '');
    setConfirming(false);
    reconcileKeyChange(id());
  });

  const state = (): VerifyState => verifyState(id());

  const claimed = () => claimedName(props.peer) || props.doorName?.trim() || null;
  const fpText = () => formatNodeFingerprint(id());
  const shortFp = () => shortFingerprint(id());
  const qr = createMemo(() => {
    try {
      return qrSvg(fingerprintQrPayload(id()));
    } catch {
      return null;
    }
  });

  const saveName = () => {
    setPetname(id(), draft());
  };

  const useSuggestion = () => {
    const c = claimed();
    if (!c) return;
    setDraft(c);
    setPetname(id(), c);
  };

  return (
    <>
      <div
        class="settings-scrim"
        classList={{ open: props.open }}
        data-contact-scrim
        onClick={() => props.onClose()}
      />
      <aside
        class="context settings-modal contact-panel"
        classList={{ open: props.open }}
        aria-label="Contact"
        aria-hidden={props.open ? 'false' : 'true'}
        aria-modal={props.open ? true : undefined}
        role="dialog"
        data-contact-panel={props.open ? 'open' : 'closed'}
        data-contact-id={id().toLowerCase()}
      >
        <div class="row settings-head">
          <h2 style={{ flex: 1, margin: 0 }}>Contact</h2>
          <button type="button" class="quiet context-toggle" data-contact-close onClick={() => props.onClose()} aria-label="Close contact">
            Close
          </button>
        </div>

        <Show when={state() === 'key-changed'}>
          <div class="panel contact-key-warn" data-contact-key-changed role="alert">
            <h3>Node key changed</h3>
            <p class="hint">
              This contact’s node key no longer matches the fingerprint you verified. Verified status was cleared.
              Compare fingerprints again before you trust this name.
            </p>
            <button type="button" class="quiet" data-contact-dismiss-key onClick={() => dismissKeyWarning(id())}>
              Dismiss warning
            </button>
          </div>
        </Show>

        <div class="panel">
          <h3>Your name for them</h3>
          <p class="hint">A petname stays on this device. It is never published or sent to their node.</p>
          <label class="field">
            <span>Petname</span>
            <input
              type="text"
              data-contact-petname
              maxlength={64}
              value={draft()}
              placeholder={shortId(id())}
              onInput={(e) => setDraft(e.currentTarget.value)}
              onChange={() => saveName()}
              onBlur={() => saveName()}
            />
          </label>
          <Show when={claimed()}>
            {(c) => (
              <p class="hint" data-contact-claimed>
                They call themselves <strong>{c()}</strong>
                <span class="claimed-tag"> self-claimed</span>
                {' · '}
                <button type="button" class="link" data-contact-use-claimed onClick={() => useSuggestion()}>
                  Use as petname
                </button>
              </p>
            )}
          </Show>
          <Show when={state() === 'verified'}>
            <p class="meta" data-contact-verified-badge>
              Verified · fingerprint matched
            </p>
          </Show>
        </div>

        <div class="panel" data-contact-verify>
          <h3>Verify</h3>
          <p class="hint">
            Compare this fingerprint in person or on a call. Matching means you are looking at the same node key.
          </p>
          <p class="contact-fp-short mono" data-contact-fp-short title={fpText()}>
            {shortFp()}
          </p>
          <p class="contact-fp mono" data-contact-fp>
            {fpText()}
          </p>
          <Show
            when={qr()}
            fallback={<p class="hint">QR unavailable for this key.</p>}
          >
            {(q) => (
              <svg
                class="qr contact-qr"
                data-contact-qr
                viewBox={`0 0 ${q().extent} ${q().extent}`}
                shape-rendering="crispEdges"
                role="img"
                aria-label="Node key as a QR code"
              >
                <rect width={q().extent} height={q().extent} fill="#ffffff" />
                <path d={q().path} fill="#000000" />
              </svg>
            )}
          </Show>
          <p class="hint mono" data-contact-qr-text>
            {fingerprintQrPayload(id())}
          </p>
          <div class="row" style={{ 'justify-content': 'flex-end', gap: 'var(--s-2)' }}>
            <Show when={state() === 'verified'}>
              <button type="button" class="quiet" data-contact-unverify onClick={() => clearVerified(id())}>
                Clear verified
              </button>
            </Show>
            <Show
              when={confirming()}
              fallback={
                <button type="button" class="primary" data-contact-verify-start onClick={() => setConfirming(true)}>
                  {state() === 'verified' ? 'Verify again' : 'Mark verified'}
                </button>
              }
            >
              <button type="button" class="quiet" data-contact-verify-cancel onClick={() => setConfirming(false)}>
                Cancel
              </button>
              <button
                type="button"
                class="primary"
                data-contact-verify-confirm
                onClick={() => {
                  markVerified(id());
                  setConfirming(false);
                }}
              >
                We matched
              </button>
            </Show>
          </div>
        </div>
      </aside>
    </>
  );
}
