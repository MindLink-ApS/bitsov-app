import { createEffect, createSignal, For, onCleanup, Show } from 'solid-js';
import type { ActionError } from './types';
import { refusalText, secondsLeft, shortKey, termLines, type ApprovalView } from './ownerApproval';

type Outcome<T> = { ok: true; value: T } | { ok: false; error: ActionError };

/**
 * What the owner pressed Approve on, what came of it, and what was dismissed:
 * it stays until Dismiss, even after the request expires, leaves the node's
 * list, or the panel is closed and opened again (the shell owns it).
 */
export function approvalMemory() {
  const [hidden, setHidden] = createSignal<Set<string>>(new Set());
  const [kept, setKept] = createSignal<Record<string, ApprovalView>>({});
  const [said, setSaid] = createSignal<Record<string, { ok: boolean; text: string }>>({});
  // The approve in flight (by op id): it outlives the panel, so leaving and coming
  // back never offers a second Approve while the first is unresolved.
  const [busy, setBusy] = createSignal<string | null>(null);
  return { hidden, setHidden, kept, setKept, said, setSaid, busy, setBusy };
}
export type ApprovalMemory = ReturnType<typeof approvalMemory>;

type Outcomes = Record<string, { ok: boolean; text: string }>;
/** The first "Approved" for an op is final: a later reply (of any kind) never overwrites it. */
export const settleOutcome = (prev: Outcomes, opId: string, outcome: { ok: boolean; text: string }): Outcomes =>
  prev[opId]?.ok ? prev : { ...prev, [opId]: outcome };

/** How long after a request's expiry failed reads keep being retried before the wait gives up. */
export const WAIT_GRACE_SECS = 60;

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
  /** A failed read of the list (said instead of "nothing is waiting"). */
  error?: string | null;
  nameOf?: (id: string) => string | null;
  approve: (opId: string, approvalMessage: string) => Promise<Outcome<ApprovalView>>;
  /** After an approve that could not be confirmed: is it still waiting at the node? */
  recheck?: (opId: string) => Promise<'pending' | 'gone' | 'unknown'>;
  /** Owned by the shell so outcomes survive leaving and reopening this panel; local if absent. */
  memory?: ApprovalMemory;
}) {
  const memory = props.memory ?? approvalMemory();
  const { hidden, setHidden, kept, setKept, said, setSaid, busy, setBusy } = memory;
  /** An "Approved" is final: nothing later (a stale reply, a second press) overwrites it. */
  const settle = (opId: string, outcome: { ok: boolean; text: string }) => setSaid((s) => settleOutcome(s, opId, outcome));
  const tap = () => (props.mobile ? 'your fingerprint' : 'Touch ID');
  const live = (v: ApprovalView) => v.status === 'pending' && secondsLeft(v, props.now) > 0;
  /** Approve is offered only while the node still lists it as waiting. */
  const waiting = (opId: string) => props.approvals.some((v) => v.op_id === opId && live(v));
  const shown = () => {
    const byId = new Map<string, ApprovalView>();
    for (const v of props.approvals) if (live(v)) byId.set(v.op_id, v);
    for (const [id, v] of Object.entries(kept())) if (!byId.has(id)) byId.set(id, v);
    return [...byId.values()].filter((v) => !hidden().has(v.op_id));
  };
  const dismiss = (opId: string) => {
    setHidden((h) => new Set(h).add(opId));
    setKept((k) => { const { [opId]: _gone, ...rest } = k; return rest; });
  };
  const approve = async (v: ApprovalView) => {
    if (busy() !== null || said()[v.op_id]?.ok) return;
    setBusy(v.op_id);
    setKept((k) => ({ ...k, [v.op_id]: v }));
    setSaid((s) => { if (s[v.op_id]?.ok) return s; const { [v.op_id]: _old, ...rest } = s; return rest; });
    try {
      const r = await props.approve(v.op_id, v.approval_message);
      if (r.ok) {
        settle(v.op_id, { ok: true, text: 'Approved. The app that asked can go on now.' });
      } else if (r.error.code === 'node') {
        // The request may have reached the node: never say "nothing was approved" here.
        settle(v.op_id, { ok: false, text: 'Couldn’t confirm whether the approval went through. Checking your node…' });
        const now = await (props.recheck?.(v.op_id) ?? Promise.resolve('unknown' as const));
        settle(v.op_id, {
          ok: false,
          text: now === 'pending'
            ? 'Couldn’t confirm the approval. Your node still lists this request as waiting, so it was not approved; you can try again.'
            : now === 'gone'
              ? 'Couldn’t confirm the approval. Your node no longer lists this request (it was approved or it expired). Check with the app that asked.'
              : 'Couldn’t confirm whether the approval went through, and your node could not be read. Check with the app that asked.',
        });
      } else {
        settle(v.op_id, { ok: false, text: refusalText(r.error.code, { reason: r.error.reason, remaining_msat: r.error.remaining_msat }) });
      }
    } finally { setBusy(null); }
  };
  return (
    <section class="panel owner-approvals" data-owner-approvals aria-labelledby="owner-approvals-title">
      <h2 id="owner-approvals-title">Approvals waiting for you</h2>
      <Show when={props.error}>
        <p class="err-note" role="alert" data-owner-approvals-error>{props.error}</p>
      </Show>
      <Show when={shown().length > 0} fallback={
        <Show when={!props.error}>
          <p class="hint" data-owner-approvals-empty>Nothing is waiting. Requests from your other apps show here; each expires after five minutes.</p>
        </Show>
      }>
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
                  <p class="hint" data-approval-expires>
                    {waiting(v.op_id) ? `Expires in ${clock(secondsLeft(v, props.now))} unless you approve it.` : 'This request is no longer waiting at your node.'}
                  </p>
                </Show>
                <details class="quiet-detail" data-approval-message>
                  <summary>Exact message your {props.mobile ? 'phone' : 'Mac'} signs</summary>
                  <pre class="approval-message">{v.approval_message}</pre>
                </details>
                <Show when={busy() === v.op_id}>
                  <p class="hint" role="status" data-approval-busy>Confirm with {tap()}…</p>
                </Show>
                <Show when={said()[v.op_id]}>
                  {(s) => <p class={s().ok ? 'ok-note' : 'err-note'} role={s().ok ? 'status' : 'alert'} data-approval-result={s().ok ? 'ok' : 'refused'}>{s().text}</p>}
                </Show>
                <div class="form-actions">
                  <Show when={!said()[v.op_id]?.ok && waiting(v.op_id)}>
                    <button type="button" class="primary soft money" data-approval-approve disabled={busy() !== null} onClick={() => void approve(v)}>
                      {busy() === v.op_id ? 'Approving…' : `Approve with ${tap()}`}
                    </button>
                  </Show>
                  <button type="button" class="soft" data-approval-dismiss disabled={busy() === v.op_id} onClick={() => dismiss(v.op_id)}>
                    {said()[v.op_id] || !waiting(v.op_id) ? 'Dismiss' : 'Not now'}
                  </button>
                </div>
                <Show when={!said()[v.op_id] && waiting(v.op_id)}>
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
  /** What happens once it is approved (e.g. first contact: "This message sends when approved."). */
  after?: string;
  pollMs?: number;
}) {
  const [view, setView] = createSignal(props.view);
  const [error, setError] = createSignal<string | null>(null);
  // Reads kept failing well past the request's expiry: stop checking, say so, offer Dismiss.
  const [gaveUp, setGaveUp] = createSignal(false);
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
      } else {
        // A failed read establishes nothing (404 after a restart, 403, 409, 500,
        // unreachable): the other device may already have approved it. Only a
        // successful read's own status counts. Keep checking; Cancel stops.
        if (Date.now() / 1000 > v.expires_at + WAIT_GRACE_SECS) { setGaveUp(true); return; }
        setError('Couldn’t check whether it was approved. Still checking; if it was approved, this goes on by itself.');
        setView({ ...v }); // keep polling
      }
    }, props.pollMs ?? 2000);
    onCleanup(() => clearTimeout(t));
  });
  const left = () => secondsLeft(view(), props.now);
  return (
    <div class="approval owner-approval-wait" data-owner-approval-wait={gaveUp() ? 'unconfirmed' : view().status}>
      <Show when={gaveUp()}>
        <p class="err-note" role="alert" data-approval-wait-unconfirmed>Couldn’t confirm whether it was approved. Ask again if needed.</p>
        <div class="form-actions">
          <button type="button" class="soft" data-approval-wait-dismiss onClick={() => props.onStop()}>Dismiss</button>
        </div>
      </Show>
      <Show when={!gaveUp() && view().status === 'pending'} fallback={<Show when={!gaveUp()}>{
        <Show when={view().status === 'consumed'} fallback={<>
          <p class="err-note" role="alert" data-approval-wait-expired>{error() ?? 'This request expired. Nothing was approved.'}</p>
          {/* A terminal state is never a dead end: dismissing frees Send (and the offer to ask again). */}
          <div class="form-actions">
            <button type="button" class="soft" data-approval-wait-dismiss onClick={() => props.onStop()}>Dismiss</button>
          </div>
        </>}>
          <p class="ok-note" role="status" data-approval-wait-approved>Approved on your other device.</p>
        </Show>
      }</Show>}>
        <p>
          <strong>Waiting for your approval on your other owner device.</strong> Open BitSov there and approve it;
          this device cannot approve its own request.
        </p>
        <ul class="owner-approval-terms" role="list"><For each={termLines(view())}>{(line, i) => <li classList={{ lead: i() === 0 }}>{line}</li>}</For></ul>
        <Show when={props.after}><p data-approval-wait-after>{props.after}</p></Show>
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

/** What a tripped spend breaker means for this app, by the node's reason. */
export type BreakerReason = 'grant_paused' | 'grant_failures_pending' | 'grant_rate_limited' | 'grant_velocity';
export const breakerReason = (code: string): BreakerReason | null =>
  code === 'grant_paused' || code === 'grant_failures_pending' || code === 'grant_rate_limited' || code === 'grant_velocity' ? code : null;

/**
 * The requester's card when its spend grant is tripped. Only a failure pause
 * needs a reset, and only that one offers "Ask your other device to reset"
 * (when the node has the breaker-reset sub-flag). Rate and velocity limits
 * recover by themselves; unresolved payments must settle first. A reset sends
 * nothing on its own: press Send again after it.
 */
export function BreakerCard(props: {
  reason: BreakerReason;
  now: number;
  /** The node has owner_device_approval_breaker_reset_v1 and this pairing is remote. */
  offerReset: boolean;
  request: () => Promise<Outcome<ApprovalView>>;
  status: (opId: string) => Promise<Outcome<ApprovalView>>;
  onReset: () => void;
}) {
  const [wait, setWait] = createSignal<ApprovalView | null>(null);
  const [asking, setAsking] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [done, setDone] = createSignal(false);
  const ask = async () => {
    if (asking()) return;
    setAsking(true); setError(null);
    try {
      const r = await props.request();
      if (r.ok) setWait(r.value);
      else setError(refusalText(r.error.code, { reason: r.error.reason, remaining_msat: r.error.remaining_msat }));
    } finally { setAsking(false); }
  };
  return (
    <div class="approval breaker-card" data-breaker={props.reason}>
      <Show when={props.reason === 'grant_paused'}>
        <p><strong>Spending is paused after failed payments.</strong> Nothing more is paid until it is reset.</p>
        <Show when={done()} fallback={
          <Show when={wait()} fallback={
            <Show when={props.offerReset} fallback={<p class="hint" data-breaker-at-node>Your node’s owner can reset it at the node.</p>}>
              <p class="hint">Rate and speed limits clear by themselves; only this pause needs a reset.</p>
              <div class="form-actions">
                <button type="button" class="primary soft" data-breaker-reset disabled={asking()} onClick={() => void ask()}>
                  {asking() ? 'Asking…' : 'Ask your other device to reset'}
                </button>
              </div>
            </Show>
          }>
            {(v) => <OwnerApprovalWait view={v()} now={props.now} status={props.status} fallback={v().owner_action}
              onStop={() => setWait(null)} onApproved={() => { setWait(null); setDone(true); props.onReset(); }} />}
          </Show>
        }>
          <p class="ok-note" role="status" data-breaker-reset-done>Reset on your other device. Nothing was sent; press Send again when you are ready.</p>
        </Show>
      </Show>
      <Show when={props.reason === 'grant_rate_limited'}>
        <p data-breaker-recovers>Too many payments for now. This clears by itself shortly; there is nothing to approve.</p>
      </Show>
      <Show when={props.reason === 'grant_velocity'}>
        <p data-breaker-recovers>Spending is going faster than this app’s limit allows. It clears by itself shortly; there is nothing to approve.</p>
      </Show>
      <Show when={props.reason === 'grant_failures_pending'}>
        <p data-breaker-pending>Waiting for unresolved payments to settle before more spending. A reset would not settle them; there is nothing to approve.</p>
      </Show>
      <Show when={error()}><p class="err-note" role="alert">{error()}</p></Show>
    </div>
  );
}
