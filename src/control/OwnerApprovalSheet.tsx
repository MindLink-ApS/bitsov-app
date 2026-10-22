import { createEffect, createSignal, createUniqueId, onCleanup, onMount, Show, untrack } from 'solid-js';
import { t } from '../i18n';
import { approvalReason, secondsLeft, shortKey, type ApprovalView } from './ownerApproval';
import { approveOwnerRequest, type OwnerApprovalsProps } from './OwnerApprovals';
import { onEscape } from './escapeStack';

type Props = OwnerApprovalsProps & { memory: NonNullable<OwnerApprovalsProps['memory']>; blocked?: boolean };

/** Shell-owned queue: a dismissal defers presentation, never removes a node request. */
export function OwnerApprovalSheets(props: Props) {
  const [active, setActive] = createSignal<ApprovalView | null>(null);
  const [notice, setNotice] = createSignal('');
  const [otherModal, setOtherModal] = createSignal(false);
  const presented = new Set<string>();
  let returnFocus: HTMLElement | null = null;
  const pending = () => props.approvals.filter(v => v.status === 'pending' && secondsLeft(v, props.now) > 0 && !props.memory.said()[v.op_id]?.ok);
  // Other flows own their current sheet. Queue arrivals until it closes.
  onMount(() => {
    const inspect = () => setOtherModal([...document.querySelectorAll('dialog[open], [aria-modal="true"]')]
      .some(el => !el.matches('[data-owner-sheet-scrim]') && !el.closest('[data-owner-sheet-scrim]')));
    const observer = new MutationObserver(inspect);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open', 'aria-modal'] });
    inspect(); onCleanup(() => observer.disconnect());
  });
  const restoreFocus = () => queueMicrotask(() => {
    if (active()) return;
    if (returnFocus?.isConnected) returnFocus.focus();
    returnFocus = null;
  });
  const dismiss = () => { props.memory.setReview(null); setActive(null); restoreFocus(); };
  onCleanup(restoreFocus);
  createEffect(() => {
    const current = active();
    const live = pending();
    const error = props.error;
    if (current) {
      if (props.memory.busy() === current.op_id) return;
      if (props.memory.said()[current.op_id]?.ok) {
        setNotice(props.memory.said()[current.op_id].text); dismiss();
      } else if (!live.some(v => v.op_id === current.op_id)) {
        setNotice(error || t(secondsLeft(current, props.now) === 0 ? 'ownerApprovalExpired' : 'ownerApprovalGone'));
        dismiss();
      }
      return;
    }
    if (props.blocked || otherModal() || error || props.memory.busy() !== null) return;
    const requested = props.memory.review();
    const next = live.find(v => v.op_id === requested) ?? live.find(v => !presented.has(v.op_id));
    if (next) {
      presented.add(next.op_id);
      untrack(() => {
        if (!returnFocus) setNotice('');
        returnFocus ??= props.memory.reviewOpener ?? document.activeElement as HTMLElement | null;
        props.memory.reviewOpener = null;
        setActive(next);
      });
    }
  });
  return <>
    <Show when={notice() && !active()}><p class="owner-sheet-status" role="status" data-owner-sheet-status>{notice()}</p></Show>
    <Show when={active()} keyed>{v => <OwnerApprovalSheet view={v} count={pending().filter(item => item.op_id === v.op_id || !presented.has(item.op_id)).length}
      memory={props.memory} now={props.now} approvals={props.approvals} approve={props.approve}
      recheck={props.recheck} onDismiss={dismiss} notice={notice()} />}</Show>
  </>;
}

function OwnerApprovalSheet(props: Props & { view: ApprovalView; count: number; notice: string; onDismiss: () => void }) {
  const title = createUniqueId();
  let scrim!: HTMLDialogElement;
  let sheet!: HTMLDivElement;
  let disposed = false;
  const busy = () => props.memory.busy() !== null;
  const outcome = () => props.memory.said()[props.view.op_id];
  onMount(() => {
    scrim.showModal(); sheet.focus();
    const keepFocus = (e: FocusEvent) => { if (!sheet.contains(e.target as Node)) sheet.focus(); };
    document.addEventListener('focusin', keepFocus);
    onCleanup(onEscape(props.onDismiss));
    onCleanup(() => {
      document.removeEventListener('focusin', keepFocus);
      // The close event can be queued by WebKit; do not let it dismiss the next sheet.
      disposed = true;
      scrim.close();
    });
  });
  return <dialog ref={scrim} class="owner-sheet-scrim" data-owner-sheet-scrim aria-labelledby={title}
    onCancel={e => { e.preventDefault(); props.onDismiss(); }} onClose={() => { if (!disposed) props.onDismiss(); }}
    onClick={e => { if (e.target === e.currentTarget) props.onDismiss(); }}>
    <div ref={sheet} class="owner-approval-sheet" tabindex="-1" data-owner-approval-sheet={props.view.op_id}
      onKeyDown={e => {
        if (e.key !== 'Tab') return;
        const controls = [...sheet.querySelectorAll<HTMLElement>('summary, button:not(:disabled)')];
        const first = controls[0]; const last = controls[controls.length - 1];
        if (e.shiftKey && (document.activeElement === first || document.activeElement === sheet)) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && (document.activeElement === last || document.activeElement === sheet)) { e.preventDefault(); first?.focus(); }
      }}>
      <Show when={props.notice}><p class="hint" role="status" data-owner-sheet-status>{props.notice}</p></Show>
      <Show when={props.count > 1}><p class="hint" data-owner-approval-queue>{t('ownerApprovalQueue', props.count)}</p></Show>
      <h2 id={title}>{t('ownerApprovalTitle')}</h2>
      {/* The host reason is intentionally verbatim, including its language and U+202F amounts. */}
      <p class="owner-sheet-terms" data-owner-sheet-terms>{approvalReason(props.view)}</p>
      <p class="hint">{t('ownerApprovalRequester', shortKey(props.view.client_pubkey))}</p>
      <details class="quiet-detail"><summary>{t('ownerApprovalSignedMessage')}</summary>
        <pre class="approval-message">{props.view.approval_message}</pre>
      </details>
      <Show when={outcome()}>{s => <p role={s().ok ? 'status' : 'alert'} class={s().ok ? 'ok-note' : 'err-note'}>{s().text}</p>}</Show>
      <button type="button" class="primary money" data-owner-sheet-approve disabled={busy()}
        onClick={() => void approveOwnerRequest(props, props.memory, props.view)}>{t(busy() ? 'ownerApprovalApproving' : 'ownerApprovalApprove')}</button>
      <button type="button" class="soft" data-owner-sheet-dismiss onClick={props.onDismiss}>{t('firstSpendNotNow')}</button>
      <p class="hint">{t('ownerApprovalDefer')}</p>
    </div>
  </dialog>;
}
