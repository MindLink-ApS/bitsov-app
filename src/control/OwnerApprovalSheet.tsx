import { isTauri } from '@tauri-apps/api/core';
import { createApprovalNotifications } from './ownerApprovalNotification';
import { createEffect, createSignal, createUniqueId, onCleanup, onMount, Show, untrack } from 'solid-js';
import { language, t } from '../i18n';
import { approvalReason, secondsLeft, type ApprovalView } from './ownerApproval';
import { approveOwnerRequest, type OwnerApprovalsProps } from './OwnerApprovals';
import { onEscape } from './escapeStack';

type Props = OwnerApprovalsProps & { memory: NonNullable<OwnerApprovalsProps['memory']>; blocked?: boolean; onNotificationReview?: () => void };

const hasOtherModal = () => [...document.querySelectorAll('dialog[open], [aria-modal="true"]')]
  .some(el => !el.matches('[data-owner-sheet-scrim]') && !el.closest('[data-owner-sheet-scrim]'));

/** Shell-owned queue: a dismissal defers presentation, never removes a node request. */
export function OwnerApprovalSheets(props: Props) {
  const [active, setActive] = createSignal<ApprovalView | null>(null);
  const [notice, setNotice] = createSignal('');
  const [otherModal, setOtherModal] = createSignal(false);
  const presented = new Set<string>();
  let returnFocus: HTMLElement | null = null;
  const pending = () => props.approvals.filter(v => v.status === 'pending' && secondsLeft(v, props.now) > 0 && !props.memory.said()[v.op_id]?.ok);
  onMount(() => {
    if (!isTauri() || !/Macintosh|Mac OS X/.test(navigator.userAgent)) return;
    const notifications = createApprovalNotifications(id => {
      props.onNotificationReview?.();
      props.memory.setReview(id);
    });
    createEffect(() => notifications.update(props.error ? [] : pending().map(v => v.op_id)));
    onCleanup(notifications.dispose);
  });
  // Other flows own their current sheet. Queue arrivals until it closes.
  onMount(() => {
    const inspect = () => setOtherModal(hasOtherModal());
    const observer = new MutationObserver(inspect);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open', 'aria-modal'] });
    inspect(); onCleanup(() => observer.disconnect());
  });
  const restoreFocus = () => queueMicrotask(() => {
    if (active() || hasOtherModal()) return;
    if (returnFocus?.isConnected) returnFocus.focus();
    returnFocus = null;
  });
  const dismiss = () => {
    if (props.memory.busy() !== null) return;
    props.memory.setReview(null); setActive(null); restoreFocus();
  };
  onCleanup(restoreFocus);
  createEffect(() => {
    if (!notice()) return;
    const timer = setTimeout(() => setNotice(''), 5_000);
    onCleanup(() => clearTimeout(timer));
  });
  createEffect(() => {
    const current = active();
    const live = pending();
    const error = props.error;
    const requested = props.memory.review();
    const selected = live.find(v => v.op_id === requested);
    if (selected && current?.op_id !== selected.op_id && !props.blocked && !otherModal()
        && !error && props.memory.busy() === null) {
      presented.add(selected.op_id);
      untrack(() => {
        setNotice('');
        returnFocus ??= props.memory.reviewOpener ?? document.activeElement as HTMLElement | null;
        props.memory.reviewOpener = null;
        setActive(selected);
      });
      return;
    }
    if (current) {
      if (props.memory.busy() === current.op_id) return;
      // Keep the result with its request until the owner dismisses it.
      if (props.memory.said()[current.op_id]) return;
      if (!live.some(v => v.op_id === current.op_id)) {
        setNotice(error || t(secondsLeft(current, props.now) === 0 ? 'ownerApprovalExpired' : 'ownerApprovalGone'));
        dismiss();
      }
      return;
    }
    if (props.blocked || otherModal() || error || props.memory.busy() !== null) return;
    const next = live.find(v => v.op_id === requested) ?? live.find(v => !presented.has(v.op_id));
    if (next) {
      presented.add(next.op_id);
      untrack(() => {
        setNotice('');
        returnFocus ??= props.memory.reviewOpener ?? document.activeElement as HTMLElement | null;
        props.memory.reviewOpener = null;
        setActive(next);
      });
    }
  });
  return <>
    <Show when={notice() && !active()}><p class="owner-sheet-status" role="status" data-owner-sheet-status>{notice()}</p></Show>
    <Show when={!props.blocked && !otherModal()}>
    <Show when={active()} keyed>{v => <OwnerApprovalSheet view={v} count={pending().length}
      memory={props.memory} now={props.now} approvals={props.approvals} approve={props.approve}
      recheck={props.recheck} onDismiss={dismiss} />}</Show>
    </Show>
  </>;
}

function OwnerApprovalSheet(props: Props & { view: ApprovalView; count: number; onDismiss: () => void }) {
  const title = createUniqueId();
  let scrim!: HTMLDialogElement;
  let sheet!: HTMLDivElement;
  let disposed = false;
  const busy = () => props.memory.busy() !== null;
  const outcome = () => props.memory.said()[props.view.op_id];
  const waiting = () => props.approvals.some(v => v.op_id === props.view.op_id && v.status === 'pending' && secondsLeft(v, props.now) > 0);
  const dismiss = () => { if (!busy()) props.onDismiss(); };
  onMount(() => {
    scrim.showModal(); sheet.focus();
    const keepFocus = (e: FocusEvent) => { if (!hasOtherModal() && !sheet.contains(e.target as Node)) sheet.focus(); };
    document.addEventListener('focusin', keepFocus);
    onCleanup(onEscape(dismiss));
    onCleanup(() => {
      document.removeEventListener('focusin', keepFocus);
      // The close event can be queued by WebKit; do not let it dismiss the next sheet.
      disposed = true;
      scrim.close();
    });
  });
  return <dialog ref={scrim} class="owner-sheet-scrim" data-owner-sheet-scrim aria-labelledby={title}
    onCancel={e => { e.preventDefault(); dismiss(); }} onClose={() => {
      if (disposed) return;
      if (busy()) { if (!scrim.open && !hasOtherModal()) scrim.showModal(); }
      else dismiss();
    }}
    onClick={e => { if (e.target === e.currentTarget) dismiss(); }}>
    <div ref={sheet} class="owner-approval-sheet" tabindex="-1" data-owner-approval-sheet={props.view.op_id}
      onKeyDown={e => {
        if (e.key !== 'Tab') return;
        const controls = [...sheet.querySelectorAll<HTMLElement>('summary, button:not(:disabled)')];
        const first = controls[0]; const last = controls[controls.length - 1];
        if (e.shiftKey && (document.activeElement === first || document.activeElement === sheet)) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && (document.activeElement === last || document.activeElement === sheet)) { e.preventDefault(); first?.focus(); }
      }}>
      <Show when={!outcome()?.ok && props.count > 1}><p class="hint" data-owner-approval-queue>{t('ownerApprovalQueue', props.count)}</p></Show>
      <h2 id={title}>{t('ownerApprovalTitle')}</h2>
      {/* The host reason is intentionally verbatim, including its language and U+202F amounts. */}
      <p class="owner-sheet-terms" data-owner-sheet-terms>{approvalReason(props.view)}</p>
      <Show when={language() === 'da'}><p class="hint">{t('ownerApprovalTermsLanguage')}</p></Show>
      <details class="quiet-detail"><summary>{t('ownerApprovalSignedMessage')}</summary>
        <pre class="approval-message">{props.view.approval_message}</pre>
      </details>
      <Show when={outcome()}>{s => <p role={s().ok ? 'status' : 'alert'} class={s().ok ? 'ok-note' : 'err-note'}>{s().text}</p>}</Show>
      <Show when={!outcome()?.ok}><button type="button" class="primary money" data-owner-sheet-approve disabled={busy() || !waiting()}
        onClick={() => void approveOwnerRequest(props, props.memory, props.view)}>{t(busy() ? 'ownerApprovalApproving' : 'ownerApprovalApprove')}</button></Show>
      <button type="button" class="soft" data-owner-sheet-dismiss disabled={busy()} onClick={dismiss}>{t(outcome() ? 'ownerApprovalDismiss' : 'firstSpendNotNow')}</button>
      <Show when={busy()}><p class="hint" role="status">{t('ownerApprovalApproving')}</p></Show>
      <Show when={!busy() && !outcome()}><p class="hint">{t('ownerApprovalDefer')}</p></Show>
    </div>
  </dialog>;
}
