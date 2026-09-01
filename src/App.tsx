import { createMemo, createSignal, onCleanup, onMount, Show } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { qrSvg } from './qr';

// CS-1 identity screen + CS-2 first-run funding. The Rust host bundles + supervises
// the node binary, mints a loopback JWT via /auth/local, and exposes every node call
// as a Tauri command. This renderer only reflects that state: it never talks to the
// node directly, never touches a non-loopback host (Gate G2), and never holds a
// credential — no mnemonic, private key, JWT or node token is read or displayed here.
// The one secret it accepts is the recovery phrase, which is write-only: masked on
// entry, passed straight to the host, and cleared the moment it is submitted.
type Status = { ready: boolean; node_id: string | null; error: string | null };

type FundState = {
  current_step: string;
  tier: string | null;
  funding_address: string | null;
  funding_amount_sats_required: number | null;
  funding_amount_sats_received: number;
  funding_evidence: string | null;
  funded: boolean;
};

type FundingAddress = { address: string; network: string | null; note: string | null };
type Balance = { balance_msat: number };
type RestoreOutcome = { node_id: string; restart_required: boolean; restarted: boolean };

const DEFAULT_FUNDING_SATS = 50_000;
const sats = (value: number) => value.toLocaleString('en-US');
const short = (id: string) => (id.length > 20 ? `${id.slice(0, 8)}…${id.slice(-8)}` : id);

export default function App() {
  const [status, setStatus] = createSignal<Status>({ ready: false, node_id: null, error: null });
  // Gate G6: the funds UI stays behind an explicit local-trust disclosure.
  const [trustAck, setTrustAck] = createSignal(false);
  const [restoring, setRestoring] = createSignal(false);
  // Lifted so IdentityGate can stay mounted when ready is false (restart_node
  // clears ready). Restore retry/error must not be gated on ready: IdentityGate
  // must still show restore errors if ready is false.
  const [restoreError, setRestoreError] = createSignal<string | null>(null);
  const showIdentityGate = () => status().ready || restoring() || restoreError() !== null;

  let timer: number | undefined;
  const poll = async () => {
    try {
      setStatus(await invoke<Status>('node_status'));
    } catch (e) {
      setStatus({ ready: false, node_id: null, error: String(e) });
    }
  };

  onMount(() => {
    void poll();
    timer = window.setInterval(() => void poll(), 1500);
  });
  onCleanup(() => {
    if (timer) window.clearInterval(timer);
  });

  return (
    <main class="shell">
      <div class="mark">
        Bit<span>Sov</span>
      </div>

      <Show
        when={showIdentityGate()}
        fallback={
          <Show
            when={status().error}
            fallback={
              <div class="state">
                <div class="spinner" />
                Starting your node…
              </div>
            }
          >
            <div class="state error">
              <div>Your node didn’t start.</div>
              <code>{status().error}</code>
              <p class="hint">
                Check that the node binary is in <code>src-tauri/bin/</code> — see{' '}
                <code>bin/README.md</code>.
              </p>
            </div>
          </Show>
        }
      >
        <Show
          when={trustAck()}
          fallback={
            <IdentityGate
              nodeId={() => status().node_id}
              onContinue={() => setTrustAck(true)}
              onRestoring={setRestoring}
              restoreError={restoreError}
              setRestoreError={setRestoreError}
            />
          }
        >
          <Show when={status().ready}>
            <Fund ready={() => status().ready} />
          </Show>
        </Show>
      </Show>
    </main>
  );
}

/**
 * Identity + the Gate G6 local-trust disclosure, which must be read and accepted
 * before any funding UI is shown. Also the place to restore an existing identity —
 * before there is money on this node, not after.
 */
function IdentityGate(props: {
  nodeId: () => string | null;
  onContinue: () => void;
  onRestoring: (value: boolean) => void;
  restoreError: () => string | null;
  setRestoreError: (value: string | null) => void;
}) {
  const [showRestore, setShowRestore] = createSignal(false);
  const [phrase, setPhrase] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [restored, setRestored] = createSignal<string | null>(null);

  const submitRestore = async (event: Event) => {
    event.preventDefault();
    // Read once, then clear immediately: the phrase lives in this component for the
    // duration of the call and nowhere else. The host forwards it to the node.
    const value = phrase();
    setPhrase('');
    if (!value.trim()) {
      setError('Enter your 12- or 24-word recovery phrase.');
      return;
    }
    setBusy(true);
    setError(null);
    // restoring() first so showIdentityGate stays true while ready is false.
    props.onRestoring(true);
    props.setRestoreError(null);
    try {
      const outcome = await invoke<RestoreOutcome>('identity_restore', { mnemonic: value });
      setRestored(outcome.node_id);
      setShowRestore(false);
      props.setRestoreError(null);
    } catch (e) {
      const message = String(e);
      setError(message);
      // Keep IdentityGate visible while ready is false so the user can retry.
      props.setRestoreError(message);
    } finally {
      setBusy(false);
      props.onRestoring(false);
    }
  };

  const displayError = () => error() ?? props.restoreError();

  return (
    <div class="state ready">
      <Show when={busy()}>
        <div class="spinner" />
        <div>Restarting with your restored identity…</div>
      </Show>
      <div class="dot" />
      <div>Your node is running.</div>
      <div class="node-id" title={props.nodeId() ?? ''}>
        {short(props.nodeId() ?? '')}
      </div>

      <section class="panel disclosure" data-gate="g6-local-trust">
        <h2>Local trust — read this before you deposit</h2>
        <p>
          This node trusts every program on this computer. Anything running under your user
          account can ask it for full access over <code>127.0.0.1</code> — enough to spend what
          you deposit and read your history. Only fund a node on a machine you control.
        </p>
        <p>
          Your keys stay in the node. BitSov never shows you your recovery phrase and never
          copies it anywhere.
        </p>
      </section>

      <button class="primary" onClick={props.onContinue}>
        I understand — continue to funding
      </button>

      <Show when={restored()}>
        <p class="ok-note">Identity restored. Your node now runs as {short(restored()!)}.</p>
      </Show>

      <Show
        when={showRestore()}
        fallback={
          <button class="link" onClick={() => setShowRestore(true)}>
            Restore an existing identity
          </button>
        }
      >
        <form class="panel restore" onSubmit={submitRestore}>
          <label for="restore-phrase">Recovery phrase (12 or 24 words)</label>
          <input
            id="restore-phrase"
            type="password"
            autocomplete="off"
            autocapitalize="none"
            autocorrect="off"
            spellcheck={false}
            disabled={busy()}
            value={phrase()}
            onInput={(e) => setPhrase(e.currentTarget.value)}
          />
          <p class="hint">
            Replaces this node’s identity with the one your phrase derives, then restarts the
            node. Do this before you deposit anything.
          </p>
          <div class="row">
            <button type="submit" class="primary" disabled={busy()}>
              {busy() ? 'Restoring…' : 'Restore'}
            </button>
            <button
              type="button"
              class="link"
              disabled={busy()}
              onClick={() => {
                setPhrase('');
                setShowRestore(false);
                setError(null);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      </Show>

      <Show when={displayError()}>
        <p class="err-note">{displayError()}</p>
      </Show>
    </div>
  );
}

/**
 * First-run funding: start the tier-`full` onboarding for an amount, show the deposit
 * address as text + QR, and poll `/onboarding/state` until the node reports it has
 * seen the funds.
 */
function Fund(props: { ready: () => boolean }) {
  const [fund, setFund] = createSignal<FundState | null | undefined>(undefined);
  const [address, setAddress] = createSignal<FundingAddress | null>(null);
  const [balance, setBalance] = createSignal<Balance | null>(null);
  const [amount, setAmount] = createSignal(String(DEFAULT_FUNDING_SATS));
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const refresh = async () => {
    if (!props.ready()) return;
    try {
      const state = await invoke<FundState | null>('fund_state');
      setFund(state);
      setError(null);
      // The onboarding record carries the address once started; fall back to the
      // payments endpoint if the node did not include one.
      if (state && !state.funding_address && !address()) {
        try {
          setAddress(await invoke<FundingAddress>('funding_address'));
        } catch {
          /* the wallet backend may not expose one — the state address is primary */
        }
      }
    } catch (e) {
      setError(String(e));
    }
    try {
      setBalance(await invoke<Balance>('payments_balance'));
    } catch {
      /* balance is informational; a transient failure must not blank the screen */
    }
  };

  let timer: number | undefined;
  onMount(() => {
    void refresh();
    timer = window.setInterval(() => {
      if (!fund()?.funded) void refresh();
    }, 3000);
  });
  onCleanup(() => {
    if (timer) window.clearInterval(timer);
  });

  const start = async (event: Event) => {
    event.preventDefault();
    const value = Number(amount());
    if (!Number.isInteger(value) || value < 1 || value > 4_294_967_295) {
      setError('Enter a whole number of sats.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setFund(await invoke<FundState>('fund_start', { funding_amount_sats: value }));
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const depositAddress = () => fund()?.funding_address ?? address()?.address ?? null;
  const qr = createMemo(() => {
    const value = depositAddress();
    if (!value) return null;
    try {
      return qrSvg(value);
    } catch {
      return null; // never let the QR break the screen; the text address is the source of truth
    }
  });
  const required = () => fund()?.funding_amount_sats_required ?? 0;
  const received = () => fund()?.funding_amount_sats_received ?? 0;
  const progress = () => (required() > 0 ? Math.min(100, (received() / required()) * 100) : 0);

  return (
    <div class="state ready fund">
      <Show when={fund() !== undefined} fallback={<div class="spinner" />}>
        <Show
          when={fund()}
          fallback={
            <form class="panel" onSubmit={start}>
              <h2>Fund your node</h2>
              <p class="hint">
                Choose how much on-chain bitcoin to deposit. Your node watches its own wallet
                and tells you when the deposit arrives.
              </p>
              <label for="amount">Amount</label>
              <div class="row">
                <input
                  id="amount"
                  type="number"
                  min="1"
                  step="1"
                  inputmode="numeric"
                  disabled={busy()}
                  value={amount()}
                  onInput={(e) => setAmount(e.currentTarget.value)}
                />
                <span class="unit">sats</span>
              </div>
              <button type="submit" class="primary" disabled={busy()}>
                {busy() ? 'Starting…' : 'Get a deposit address'}
              </button>
            </form>
          }
        >
          <Show
            when={!fund()!.funded}
            fallback={
              <div class="panel funded">
                <div class="dot" />
                <h2>Funding seen</h2>
                <p class="hint">
                  Your node observed {sats(received())} sats. Opening a Lightning channel and
                  sending your first paid message come next (M1 / M2).
                </p>
                <Show when={fund()!.funding_evidence}>
                  <p class="evidence">Evidence: {fund()!.funding_evidence}</p>
                </Show>
              </div>
            }
          >
            <div class="panel">
              <h2>Deposit to your node</h2>
              <Show
                when={depositAddress()}
                fallback={<p class="hint">Waiting for the node to produce a deposit address…</p>}
              >
                <Show when={qr()}>
                  <svg
                    class="qr"
                    viewBox={`0 0 ${qr()!.extent} ${qr()!.extent}`}
                    shape-rendering="crispEdges"
                    role="img"
                    aria-label="Deposit address as a QR code"
                  >
                    <rect width={qr()!.extent} height={qr()!.extent} fill="#ffffff" />
                    <path d={qr()!.path} fill="#000000" />
                  </svg>
                </Show>
                <code class="address">{depositAddress()}</code>
                <p class="hint">
                  Send on-chain bitcoin to this address
                  <Show when={address()?.network}>{` (${address()!.network})`}</Show>. It stays
                  valid — scan it or copy the text above.
                </p>
              </Show>

              <div class="progress">
                <div class="bar">
                  <div class="fill" style={{ width: `${progress()}%` }} />
                </div>
                <div class="numbers">
                  <strong>{sats(received())}</strong> of {sats(required())} sats seen
                </div>
              </div>
              <p class="hint">
                Waiting for your deposit. The node re-checks its wallet every few seconds;
                on-chain confirmation can take a while.
              </p>
            </div>
          </Show>
        </Show>
      </Show>

      <Show when={balance()}>
        <div class="balance">
          Node balance: <strong>{sats(Math.floor(balance()!.balance_msat / 1000))}</strong> sats
          <span class="msat">({sats(balance()!.balance_msat)} msat)</span>
        </div>
      </Show>

      <Show when={error()}>
        <p class="err-note">{error()}</p>
      </Show>
    </div>
  );
}
