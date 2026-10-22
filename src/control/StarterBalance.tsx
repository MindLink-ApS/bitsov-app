import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from 'solid-js';
import { t } from '../i18n';
import { amount } from './format';
import type { StarterApi, StarterStatus } from './starter';

const inFlight = new Set<string>();
const scheduled = (s: StarterStatus) => s.state === 'refused' && s.retry_allowed === true
  && s.retry_after_unix != null && s.detail !== 'auto_retry_exhausted';
const adopting = (s: StarterStatus) => s.detail?.startsWith('adopt:') === true;
const confirmed = (s: StarterStatus) => s.state === 'ready' && s.verified === true;

export type StarterBalanceProps = {
  enabled?: boolean; network?: string | null; capabilities?: string[]; nodeId: string; api: StarterApi;
};
type Navigation = { open?: boolean; onOpen?: () => void; onHidden?: () => void };

/** Gate before mounting: an unknown network/capability never triggers discovery. */
export function StarterBalance(props: StarterBalanceProps & Navigation) {
  const eligible = () => (props.enabled ?? (import.meta.env.VITE_STARTER_BALANCE === '1'))
    && props.network === 'signet' && props.capabilities?.includes('starter_channel_request_v1') && props.nodeId;
  return <Show when={eligible()} keyed>{nodeId => <StarterStep nodeId={nodeId} api={props.api}
    open={props.open} onOpen={props.onOpen} onHidden={props.onHidden} />}</Show>;
}

function StarterStep(props: { nodeId: string; api: StarterApi } & Navigation) {
  // Scope intent to the identity, not an endpoint that can be repointed.
  const key = `bitsov.starter-request.${props.nodeId}`;
  const [status, setStatus] = createSignal<StarterStatus | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<'read' | 'request' | 'storage' | null>(null);
  const [now, setNow] = createSignal(Date.now());
  let alive = true;
  let reading = false;
  const [savedId, setSavedId] = createSignal<string | null>(null);
  try { setSavedId(localStorage.getItem(key)); } catch { setError('storage'); }

  const accept = (next: StarterStatus) => {
    if (!alive) return;
    // Retryable refusals are still a live lineage: the node creates successors.
    // The app continues to persist and replay the original owner request ID.
    const olderTerminal = next.request_id !== savedId() && savedId() !== null
      && (confirmed(next) || (next.state === 'refused' && !scheduled(next) && !adopting(next)));
    try {
      if (olderTerminal) {
        // A failed newer POST may not be visible yet. An older refusal must
        // never erase its write-ahead ID, including on the first restart poll.
      } else if (confirmed(next) || (next.state === 'refused' && !scheduled(next) && !adopting(next))) {
        localStorage.removeItem(key);
        setSavedId(null);
      } else if (next.request_id) {
        localStorage.setItem(key, next.request_id);
        setSavedId(next.request_id);
      }
      setError(olderTerminal ? 'request' : null);
    } catch { setError('storage'); }
    setStatus(next);
  };
  const refresh = async () => {
    if (reading || busy() || inFlight.has(key)) return;
    reading = true;
    try { accept(await props.api.current()); }
    catch { if (alive) setError('read'); }
    finally { reading = false; }
  };
  onMount(() => {
    void refresh();
    const timer = window.setInterval(() => { setNow(Date.now()); void refresh(); }, 5000);
    onCleanup(() => window.clearInterval(timer));
  });
  createEffect(() => { if (status()?.hub_configured !== true) props.onHidden?.(); });
  onCleanup(() => { alive = false; props.onHidden?.(); });

  const send = async () => {
    if (!alive || !canAct() || busy() || reading || inFlight.has(key) || !status()?.hub_configured) return;
    setBusy(true);
    inFlight.add(key);
    try {
      let id: string;
      try {
        id = savedId() ?? localStorage.getItem(key) ?? crypto.randomUUID();
        // Write ahead of dispatch. Storage failure must never send a request.
        localStorage.setItem(key, id);
        setSavedId(id);
      } catch { setError('storage'); return; }
      try { accept(await props.api.request(id)); }
      catch { if (alive) setError('request'); }
    } finally { inFlight.delete(key); if (alive) setBusy(false); }
  };
  const words = createMemo(() => {
    const s = status();
    if (!s) return '';
    if (adopting(s)) return t('starterWaiting');
    if (scheduled(s)) return t('starterRetrying', Math.max(0, Math.ceil((s.retry_after_unix! * 1000 - now()) / 60000)));
    if (s.detail === 'auto_retry_exhausted') return t('starterFailed');
    if (confirmed(s)) return t('starterReady');
    if (s.state === 'opening' || s.state === 'ready') return t('starterOpening');
    if (s.state === 'refused') return t('starterRefused');
    if (s.state === 'requested') return t(s.detail ? 'starterWaiting' : 'starterRequested');
    return '';
  });
  const canAct = () => {
    const s = status();
    return s && !confirmed(s) && !scheduled(s) && !adopting(s)
      && (s.state === 'refused' || s.state === 'not_requested' || error() === 'request' || error() === 'read'
        || s.detail === 'delivery_retry_exhausted' || s.detail === 'hub_silent_24h');
  };
  return <Show when={status()?.hub_configured === true}>
    <Show when={props.open !== false} fallback={
      <button type="button" class="link" data-starter-entry onClick={() => props.onOpen?.()}>{t('starterTitle')}</button>
    }>
    <section class="wallet-section" aria-label={t('starterTitle')} data-starter-balance>
      <h2>{t('starterTitle')}</h2>
      <p class="hint">{t('starterFree')}</p>
      <Show when={status()?.hub_alias}>{alias => <p data-starter-hub>{alias()}</p>}</Show>
      <p role="status" aria-live="polite">{words()}</p>
      <Show when={status() && confirmed(status()!)} fallback={<p class="hint">{t('starterPending')}</p>}>
        <Show when={Number.isSafeInteger(status()?.push_sats) && status()!.push_sats! >= 0}>
          <p>{t('starterReceived', amount(status()!.push_sats! * 1000))}</p>
        </Show>
        <p class="hint">{t('starterSpendable')}</p>
      </Show>
      <Show when={error()}><p class="err-note" role="status">{t(error() === 'storage' ? 'starterStorageError' : error() === 'read' ? 'starterReadError' : 'starterRequestError')}</p></Show>
      <Show when={canAct()}><button type="button" class="primary soft" disabled={busy()}
        ref={el => queueMicrotask(() => el.isConnected && el.focus())} onClick={() => void send()}>
        {t(savedId() ? 'starterRetry' : status()?.state === 'refused' ? 'starterAgain' : status()?.state !== 'not_requested' ? 'starterRetry' : 'starterGet')}
      </button></Show>
    </section>
    </Show>
  </Show>;
}
