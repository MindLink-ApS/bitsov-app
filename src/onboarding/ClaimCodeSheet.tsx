import { createSignal, createUniqueId, onCleanup, onMount, Switch, Match } from 'solid-js';
import { t } from '../i18n';
import { onEscape } from '../control/escapeStack';

export type ClaimCodeView = {state:'open'; code:string; expires_at:number} | {state:'closed'|'claimed'|'unavailable'};
const clearCode = (view: ClaimCodeView | undefined) => { if (view?.state === 'open') view.code = ''; };

/** The response belongs to this sheet only, including while its request is in flight. */
export function ClaimCodeSheet(props: { load:()=>Promise<ClaimCodeView>; onClose:()=>void }) {
  const [view, setView] = createSignal<ClaimCodeView>();
  const [expired, setExpired] = createSignal(false);
  const [error, setError] = createSignal('');
  const [now, setNow] = createSignal(Date.now()/1000);
  const title = createUniqueId();
  let scrim!: HTMLDialogElement;
  let sheet!: HTMLDivElement;
  let disposed = false;
  const clear = () => { clearCode(view()); setView(undefined); };
  const dismiss = () => { clear(); props.onClose(); };
  const open = () => { const v = view(); return v?.state === 'open' ? v : undefined; };
  const remaining = () => Math.max(0, Math.ceil((open()?.expires_at ?? 0)-now()));
  const countdown = () => `${Math.floor(remaining()/60)}:${String(remaining()%60).padStart(2, '0')}`;
  const expire = () => {
    if (open() && remaining() === 0) { clear(); setExpired(true); }
  };
  onMount(() => {
    const opener = document.activeElement as HTMLElement | null;
    scrim.showModal(); sheet.focus();
    const keepFocus = (event: FocusEvent) => { if (!sheet.contains(event.target as Node)) sheet.focus(); };
    document.addEventListener('focusin', keepFocus);
    onCleanup(onEscape(dismiss));
    const timer = setInterval(() => { setNow(Date.now()/1000); expire(); }, 1000);
    void props.load().then(next => {
      if (disposed) { clearCode(next); return; }
      setNow(Date.now()/1000); setView(next); expire();
    }).catch(reason => {
      if (disposed) return;
      const kind = reason && typeof reason === 'object' ? reason.kind : '';
      setError(t(kind === 'claim_code_owner_local' ? 'obClaimOwnerLocal'
        : kind === 'claim_code_owner_required' ? 'obUseOwnerDevice'
        : kind === 'claim_code_rate_limited' ? 'obClaimRateLimited' : 'obClaimLoadFailed'));
    });
    onCleanup(() => {
      disposed = true; clear(); clearInterval(timer);
      document.removeEventListener('focusin', keepFocus);
      scrim.close();
      queueMicrotask(() => { if (opener?.isConnected) opener.focus(); });
    });
  });
  return <dialog ref={scrim} class="first-spend-scrim" aria-labelledby={title} data-claim-code-sheet
    onCancel={event => { event.preventDefault(); dismiss(); }}
    onClose={() => { if (!disposed) dismiss(); }}
    onClick={event => { if (event.target === event.currentTarget) dismiss(); }}>
    <div ref={sheet} class="first-spend-sheet" tabindex="-1" onKeyDown={event => {
      if (event.key !== 'Tab') return;
      const close = sheet.querySelector('button');
      event.preventDefault(); close?.focus();
    }}>
      <h2 id={title}>{t('obShowClaimCode')}</h2>
      <Switch>
        <Match when={error()}><p role="alert">{error()}</p></Match>
        <Match when={expired()}><p role="status" data-claim-state>{t('obClaimExpired')}</p></Match>
        <Match when={open()}>
          <p class="owner-claim-code" data-owner-claim-code>{open()?.code.match(/.{1,6}/g)?.join(' ')}</p>
          <p role="status" data-claim-countdown>{t('obClaimExpires', countdown())}</p>
        </Match>
        <Match when={view()}><p role="status" data-claim-state>{t(view()?.state === 'closed' ? 'obClaimClosed' : view()?.state === 'claimed' ? 'obClaimClaimed' : 'obClaimUnavailable')}</p></Match>
        <Match when={!view()}><p role="status">{t('obChecking')}</p></Match>
      </Switch>
      <button type="button" class="quiet" onClick={dismiss}>{t('obCloseClaimCode')}</button>
    </div>
  </dialog>;
}
