import { t, type CopyKey } from '../i18n';
import { createSignal, createUniqueId, For, Show } from 'solid-js';
import { Dynamic } from 'solid-js/web';

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
