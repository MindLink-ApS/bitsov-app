import { createEffect, createSignal, For, onCleanup, Show } from 'solid-js';
import type { ActionError } from './types';
import { refusalText, secondsLeft, shortKey, termLines, type ApprovalView } from './ownerApproval';

type Outcome<T> = { ok: true; value: T } | { ok: false; error: ActionError };

const clock = (secs: number) => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;

/**
 * Owner side of owner-approval-v1: requests this owner device may approve
 * (the node never lists this pairing's own). Each shows the node's terms from
 * its structured request, the requesting app's key fingerprint (the node gives
 * no name), the exact message the device signs, and the time left. Approve
 * asks the host, which re-reads the request, refuses if the message changed,
 * and signs it with Touch ID. Dismiss only hides it here: there is no decline;
 * it expires at the node by itself.
 */
export function OwnerApprovals(props: {
  approvals: ApprovalView[];
  now: number;
  mobile?: boolean;
  nameOf?: (id: string) => string | null;
  approve: (opId: string, approvalMessage: string) => Promise<Outcome<ApprovalView>>;
}) {
  const [hidden, setHidden] = createSignal<Set<string>>(new Set());
  const [busy, setBusy] = createSignal<string | null>(null);
  const [said, setSaid] = createSignal<Record<string, { ok: boolean; text: string }>>({});
  const tap = () => (props.mobile ? 'your fingerprint' : 'Touch ID');
  const shown = () => props.approvals.filter((v) => !hidden().has(v.op_id) && (said()[v.op_id]?.ok || (v.status === 'pending' && secondsLeft(v, props.now) > 0)));
  const approve = async (v: ApprovalView) => {
    if (busy()) return;
    setBusy(v.op_id);
    try {
      const r = await props.approve(v.op_id, v.approval_message);
      setSaid((s) => ({ ...s, [v.op_id]: r.ok
        ? { ok: true, text: 'Approved. The app that asked can go on now.' }
        : { ok: false, text: refusalText(r.error.code, { reason: r.error.reason, remaining_msat: r.error.remaining_msat }) } }));
    } finally { setBusy(null); }
  };
  return (
    <section class="panel owner-approvals" data-owner-approvals aria-labelledby="owner-approvals-title">
      <h2 id="owner-approvals-title">Approvals waiting for you</h2>
      <Show when={shown().length > 0} fallback={<p class="hint" data-owner-approvals-empty>Nothing is waiting. Requests from your other apps show here; each expires after five minutes.</p>}>
        <ul class="owner-approval-list" role="list">
          <For each={shown()}>
            {(v) => (
              <li class="owner-approval" data-owner-approval={v.op_id}>
                <ul class="owner-approval-terms" data-approval-terms role="list">
                  <For each={termLines(v, props.nameOf)}>{(line, i) => <li classList={{ lead: i() === 0 }}>{line}</li>}</For>
                </ul>
                <p class="hint" data-approval-client>
                  Requested by app <code>{shortKey(v.client_pubkey)}</code>. Your node does not name the app; compare this with the app that asked.
                </p>
                <Show when={!said()[v.op_id]?.ok}>
                  <p class="hint" data-approval-expires>Expires in {clock(secondsLeft(v, props.now))} unless you approve it.</p>
                </Show>
                <details class="quiet-detail" data-approval-message>
                  <summary>Exact message your {props.mobile ? 'phone' : 'Mac'} signs</summary>
                  <pre class="approval-message">{v.approval_message}</pre>
                </details>
                <Show when={said()[v.op_id]}>
                  {(s) => <p class={s().ok ? 'ok-note' : 'err-note'} role={s().ok ? 'status' : 'alert'} data-approval-result={s().ok ? 'ok' : 'refused'}>{s().text}</p>}
                </Show>
                <Show when={!said()[v.op_id]?.ok}>
                  <div class="form-actions">
                    <button type="button" class="primary soft money" data-approval-approve disabled={busy() !== null} onClick={() => void approve(v)}>
                      {busy() === v.op_id ? 'Approving…' : `Approve with ${tap()}`}
                    </button>
                    <button type="button" class="soft" data-approval-dismiss disabled={busy() === v.op_id}
                      onClick={() => setHidden((h) => new Set(h).add(v.op_id))}>Not now</button>
                  </div>
                  <p class="hint">Not now only hides it here. Nothing is sent; it expires by itself.</p>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </section>
  );
}

/**
 * Requester side: this app asked for an owner approval and waits for it on the
 * owner's other device (a device never approves its own app's request). It
 * polls the request, counts down, and says each outcome. Cancel only stops
 * waiting here: the node has no cancel; the request expires by itself.
 */
export function OwnerApprovalWait(props: {
  view: ApprovalView;
  now: number;
  status: (opId: string) => Promise<Outcome<ApprovalView>>;
  onApproved: (view: ApprovalView) => void;
  onStop: () => void;
  /** The node's own command for the same approval, kept under "Other ways". */
  fallback?: string | null;
  pollMs?: number;
}) {
  const [view, setView] = createSignal(props.view);
  const [error, setError] = createSignal<string | null>(null);
  let alive = true;
  onCleanup(() => { alive = false; });
  createEffect(() => {
    const v = view();
    if (v.status !== 'pending') return;
    const t = setTimeout(async () => {
      const r = await props.status(v.op_id);
      if (!alive) return;
      if (r.ok) {
        setError(null);
        setView(r.value);
        if (r.value.status === 'consumed') props.onApproved(r.value);
      } else if (r.error.code === 'approval_unknown' || r.error.code === 'approval_expired') {
        setView({ ...v, status: 'expired' });
        setError(refusalText(r.error.code));
      } else {
        setError(refusalText(r.error.code, { reason: r.error.reason, remaining_msat: r.error.remaining_msat }));
        setView({ ...v }); // keep polling
      }
    }, props.pollMs ?? 2000);
    onCleanup(() => clearTimeout(t));
  });
  const left = () => secondsLeft(view(), props.now);
  return (
    <div class="approval owner-approval-wait" data-owner-approval-wait={view().status}>
      <Show when={view().status === 'pending'} fallback={
        <Show when={view().status === 'consumed'} fallback={<p class="err-note" role="alert" data-approval-wait-expired>{error() ?? 'This request expired. Nothing was approved.'}</p>}>
          <p class="ok-note" role="status" data-approval-wait-approved>Approved on your other device.</p>
        </Show>
      }>
        <p>
          <strong>Waiting for your approval on your other owner device.</strong> Open BitSov there and approve it;
          this device cannot approve its own request.
        </p>
        <ul class="owner-approval-terms" role="list"><For each={termLines(view())}>{(line, i) => <li classList={{ lead: i() === 0 }}>{line}</li>}</For></ul>
        <p class="hint" data-approval-wait-expires>Expires in {clock(left())}. Cancel only stops waiting here; the request expires by itself.</p>
        <Show when={error()}><p class="err-note" role="alert">{error()}</p></Show>
        <div class="form-actions">
          <button type="button" class="soft" data-approval-wait-cancel onClick={() => props.onStop()}>Cancel</button>
        </div>
      </Show>
      <Show when={props.fallback}>
        <details class="other-ways" data-other-ways>
          <summary>Other ways</summary>
          <code class="address" data-owner-action>{props.fallback}</code>
        </details>
      </Show>
    </div>
  );
}
