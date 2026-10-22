import { t, type CopyKey } from '../i18n';
import { createSignal, createUniqueId, For, onCleanup, onMount, Show } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { SoftError } from './SoftError';
import { onEscape } from './escapeStack';

// Lightning provider disclosure. Approved EN/DA sentences live in src/appCopy.ts
// (hub* keys); update that copy table when product wording changes.
export const HUB_TRUST_CARDS: readonly { heading: CopyKey; lines: readonly CopyKey[] }[] = [
  { heading: 'hubTitle', lines: ['hubProvider'] },
  { heading: 'hubCannotHeading', lines: ['hubCannotRead', 'hubCannotSpend'] },
  { heading: 'hubSeesHeading', lines: ['hubSees'] },
  { heading: 'hubRefusesHeading', lines: ['hubRefuses'] },
  { heading: 'hubLockedHeading', lines: ['hubLocked'] },
  { heading: 'hubFeesHeading', lines: ['hubFees'] },
];

type Level = 2 | 3;

/** `quietTitle`: opened from its ⓘ toggle, which already shows the title; it stays for screen readers only. */
export function HubTrust(props: { level: Level; titleId?: string; onDismiss?: () => void; quietTitle?: boolean }) {
  const fallbackId = createUniqueId();
  const titleId = () => props.titleId ?? fallbackId;
  return (
    <section class="panel disclosure hub-trust" aria-labelledby={titleId()} data-hub-trust>
      <div class="hub-trust-head">
        <Dynamic component={`h${props.level}`} id={titleId()} class="hub-trust-title" classList={{ 'sr-only': props.quietTitle }}>{t('hubTitle')}</Dynamic>
        <Show when={props.onDismiss}>
          <button type="button" class="quiet" data-hub-trust-dismiss aria-label={t('hubHideLabel', t('hubTitle'))} onClick={() => props.onDismiss!()}>{t('hubHide')}</button>
        </Show>
      </div>
      <ul class="hub-trust-cards" role="list">
        <For each={HUB_TRUST_CARDS}>
          {(card) => (
            <li class="hub-trust-card">
              <Dynamic component={`h${props.level + 1}`} class="hub-trust-card-title">{t(card.heading)}</Dynamic>
              <For each={card.lines}>{(line) => <p>{t(line)}</p>}</For>
            </li>
          )}
        </For>
      </ul>
    </section>
  );
}

/** An ⓘ button that shows and hides the disclosure. */
export function HubTrustInfo(props: { level: Level; initiallyOpen?: boolean; onHide?: () => void }) {
  const [open, setOpen] = createSignal(props.initiallyOpen ?? false);
  const panelId = createUniqueId();
  let toggle: HTMLButtonElement | undefined;
  const hide = () => {
    setOpen(false);
    props.onHide?.();
    toggle?.focus();
  };
  return (
    <div class="hub-trust-info" data-hub-trust-info>
      <button
        ref={toggle}
        type="button"
        class="quiet hub-trust-toggle"
        aria-expanded={open()}
        aria-controls={panelId}
        data-hub-trust-toggle
        onClick={() => (open() ? hide() : setOpen(true))}
      >
        <span aria-hidden="true">ⓘ</span>
        <span>{t('hubTitle')}</span>
      </button>
      <div id={panelId}>
        <Show when={open()}>
          <HubTrust level={props.level} onDismiss={hide} quietTitle />
        </Show>
      </div>
    </div>
  );
}

const LOCKED_HIDDEN_KEY = 'bitsov.hub-trust.locked-hidden.v1';

export function lockedHubTrustHidden(): boolean {
  try { return localStorage.getItem(LOCKED_HIDDEN_KEY) === 'hidden'; }
  catch { return false; }
}

export function hideLockedHubTrust(): void {
  try { localStorage.setItem(LOCKED_HIDDEN_KEY, 'hidden'); }
  catch { /* stays hidden for this screen only */ }
}

// One acknowledgement per node identity; a different node is a new decision.
const ackKey = (nodeId: string) => `bitsov.hub-channel-ack.v1.${nodeId.toLowerCase()}`;
const sessionAcks = new Set<string>();

export function hubChannelAcknowledged(nodeId: string): boolean {
  const key = ackKey(nodeId);
  if (sessionAcks.has(key)) return true;
  try { return localStorage.getItem(key) === 'accepted'; }
  catch { return false; }
}

export function acknowledgeHubChannel(nodeId: string): void {
  const key = ackKey(nodeId);
  sessionAcks.add(key);
  try { localStorage.setItem(key, 'accepted'); }
  catch { /* acknowledgement still holds for this session */ }
}

/**
 * The one-time confirm step before a node opens its first channel to the
 * MindLink hub. Any path that opens a hub channel must go through it: until the
 * owner acknowledges, `onConfirm` is never called. Once acknowledged for this
 * node, it calls `onConfirm` straight away and shows nothing.
 */
export function HubChannelConfirm(props: { nodeId: string; onConfirm: () => void | Promise<void>; onCancel: () => void }) {
  const already = hubChannelAcknowledged(props.nodeId);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const titleId = createUniqueId();
  let dialog: HTMLDivElement | undefined;
  const proceed = async () => {
    if (busy()) return;
    setBusy(true);
    setError(null);
    try { await props.onConfirm(); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  const confirm = () => {
    acknowledgeHubChannel(props.nodeId);
    void proceed();
  };
  onMount(() => {
    if (already) void proceed();
    else {
      const opener = document.activeElement as HTMLElement | null;
      dialog?.focus();
      onCleanup(onEscape(() => { if (!busy()) props.onCancel(); }));
      onCleanup(() => queueMicrotask(() => { if (opener?.isConnected) opener.focus(); }));
    }
  });
  return (
    <>
      <Show when={!already}>
        <div ref={dialog} class="hub-channel-confirm" role="dialog" aria-labelledby={titleId} tabindex="-1" data-hub-channel-confirm>
          <HubTrust level={2} titleId={titleId} />
          <p class="hint">{t('hubReadOnce')}</p>
          <div class="row">
            <button type="button" class="primary" data-hub-channel-ack disabled={busy()} onClick={confirm}>
              {busy() ? t('hubOpening') : t('hubConfirm')}
            </button>
            <button type="button" class="link" data-hub-channel-cancel disabled={busy()} onClick={() => props.onCancel()}>{t('hubNotNow')}</button>
          </div>
        </div>
      </Show>
      <Show when={error()}><SoftError message={error()!} /></Show>
    </>
  );
}
