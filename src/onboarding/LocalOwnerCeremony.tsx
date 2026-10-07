import { createSignal, For, onCleanup, Show } from 'solid-js';
import { usePairingActivity } from '../pairingActivity';
import { invoke } from '@tauri-apps/api/core';
export interface PendingOwner {
  ceremony_id: string; node_id: string; mnemonic: string;
  backup_check: number[]; expires_at: number;
}
export interface OwnerApi {
  create(): Promise<PendingOwner>;
  cancel(ceremonyId?: string): Promise<void>;
  finalize(words: string[]): Promise<void>;
  reconcile(): Promise<void>;
}
export const ownerApi: OwnerApi = {
  create: () => invoke('local_owner_create'),
  cancel: (ceremony_id) => invoke('local_owner_cancel', { ceremony_id }),
  finalize: (backup_words) => invoke('local_owner_finalize', { backup_words }),
  reconcile: () => invoke('local_owner_reconcile'),
};

/** The only renderer surface allowed to receive a newly generated phrase.
 * No persistence, logging or clipboard. JS/IPC copies cannot be physically zeroized. */
export function LocalOwnerCeremony(props: { api?: OwnerApi; onComplete: () => void }) {
  usePairingActivity(() => true);
  const api = props.api ?? ownerApi;
  const [step, setStep] = createSignal<'start' | 'phrase' | 'backup' | 'uncertain' | 'done'>('start');
  const [phrase, setPhrase] = createSignal('');
  const [indices, setIndices] = createSignal<number[]>([]);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  let words = ['', '', ''];
  let ceremonyId: string | undefined;
  let root: HTMLElement | undefined;
  let alive = true;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  const disarmExpiry = () => { clearTimeout(expiryTimer); };
  const clear = () => {
    setPhrase(''); words.fill('');
    root?.querySelectorAll('input').forEach(input => { input.value = ''; });
  };
  onCleanup(() => { alive = false; disarmExpiry(); clear(); });
  const run = async (action: () => Promise<void>) => {
    if (busy()) return;
    setBusy(true); setError('');
    try { await action(); } catch (e) { if (alive) setError(String(e)); }
    finally { if (alive) setBusy(false); }
  };
  const create = () => run(async () => {
    clear();
    const reply = await api.create();
    if (alive) {
      ceremonyId = reply.ceremony_id;
      setIndices(reply.backup_check); setPhrase(reply.mnemonic); setStep('phrase');
      disarmExpiry();
      expiryTimer = setTimeout(() => {
        clear(); setStep('uncertain'); setError('Setup time expired. Cancel this attempt and create a new recovery phrase.');
      }, Math.max(0, Math.min(30 * 60 * 1000, reply.expires_at * 1000 - Date.now())));
    }
    reply.mnemonic = '';
    // An unmounted screen must not retain a pending phrase it never showed.
    if (!alive) await api.cancel(reply.ceremony_id);
  });
  const cancel = () => run(async () => {
    clear(); setStep('uncertain');
    await api.cancel(ceremonyId);
    ceremonyId = undefined;
    if (alive) { disarmExpiry(); setStep('start'); setError('Setup cancelled. A new attempt will have a new recovery phrase.'); }
  });
  const finalize = () => run(async () => {
    const submitted = words.map(w => w.trim().toLowerCase());
    clear(); setStep('uncertain');
    try {
      await api.finalize(submitted);
      if (alive) { disarmExpiry(); setStep('done'); props.onComplete(); }
    } finally { submitted.fill(''); }
  });
  return <section ref={root} class="panel" aria-label="Set up this Mac as owner" data-local-owner>
    <h2>Set up this Mac as owner</h2>
    <p>Your recovery phrase controls your identity. This Mac keeps its seed password in Keychain and uses Touch ID for device approvals.</p>
    <p>Development preview: an unsigned app has weaker Keychain protection.</p>
    <Show when={step() === 'start'}>
      <p>Create a new identity on this Mac. Keep its recovery phrase somewhere private and offline.</p>
      <button disabled={busy()} onClick={create}>Create identity</button>
    </Show>
    <Show when={step() === 'phrase'}>
      <h3>Write down your recovery phrase</h3>
      <p>This is its only display. The identity has not been saved yet. Do not take a screenshot.</p>
      <p class="recovery-phrase" style={{ 'user-select': 'none', 'overflow-wrap': 'anywhere', 'line-height': '2' }}>{phrase()}</p>
      <button disabled={busy()} onClick={() => { clear(); setStep('backup'); }}>I wrote it down</button>
    </Show>
    <Show when={step() === 'backup'}>
      <p>Enter these three words from your written backup, in this order.</p>
      <For each={indices()}>{(index, i) => <div>
        <label for={`backup-${i()}`}>Word {index + 1}</label>
        <input id={`backup-${i()}`} type="password" autocomplete="off" autocapitalize="none" spellcheck={false}
          onInput={e => { words[i()] = e.currentTarget.value; }} disabled={busy()} />
      </div>}</For>
      <button disabled={busy()} onClick={finalize}>Confirm backup with Touch ID</button>
    </Show>
    <Show when={step() === 'uncertain'}>
      <p>Setup is not confirmed. Check the node before continuing. If it did not commit, cancel this attempt and create a new phrase.</p>
      <button disabled={busy()} onClick={() => run(async () => {
        await api.reconcile(); if (alive) { disarmExpiry(); setStep('done'); props.onComplete(); }
      })}>Check node and continue</button>
    </Show>
    <Show when={step() !== 'start' && step() !== 'done'}>
      <button class="quiet" disabled={busy()} onClick={cancel}>Cancel setup</button>
    </Show>
    <Show when={step() === 'done'}><p>Identity saved. Checking this Mac’s owner device…</p></Show>
    <Show when={error()}><p role="alert">{error()}</p></Show>
  </section>;
}
