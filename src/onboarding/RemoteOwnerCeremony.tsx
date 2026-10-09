import { createSignal, For, onCleanup, Show } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { usePairingActivity } from '../pairingActivity';

export type SetupInput =
  | { action: 'create'; password: string; claim_code: string }
  | { action: 'finalize'; backup_words: string[] }
  | { action: 'match' | 'cancel' | 'poll' };
export type SetupView =
  | { state: 'compare'; words: string[]; expires_at: number }
  | { state: 'backup'; mnemonic: string; backup_check: number[]; expires_at: number }
  | { state: 'backup_check'; backup_check: number[] }
  | { state: 'waiting_for_box_approval' | 'starting' | 'done' | 'words_differ' };
const setupApi = (input: SetupInput): Promise<SetupView> => invoke('remote_owner_setup', { input });

/** Input is write-only. No secret is kept in reactive state or browser storage
 * after submit. JS/IPC copies cannot be physically zeroized. */
export function RemoteOwnerCeremony(props: {
  api?: (input: SetupInput) => Promise<SetupView>; onComplete: () => void;
}) {
  const api = props.api ?? setupApi;
  const [step, setStep] = createSignal<'start' | 'compare' | 'phrase' | 'backup' | 'waiting_for_box_approval' | 'starting' | 'done' | 'words_differ' | 'uncertain'>('start');
  const [sas, setSas] = createSignal<string[]>([]);
  const [phrase, setPhrase] = createSignal('');
  const [indices, setIndices] = createSignal<number[]>([]);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  usePairingActivity(() => busy() || !['start', 'done', 'words_differ', 'uncertain'].includes(step()));
  let root!: HTMLElement;
  let alive = true;
  let pending = false;
  let approvalPollDelay = 2000;
  let poll: ReturnType<typeof setTimeout> | undefined;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  const clearInputs = () => root?.querySelectorAll('input').forEach(input => { input.value = ''; });
  const clear = () => { clearInputs(); setPhrase(''); setSas([]); };
  const stopTimers = () => { clearTimeout(poll); clearTimeout(expiry); };
  onCleanup(() => {
    alive = false; stopTimers(); clear();
    if (pending) void api({ action: 'cancel' }).catch(() => {});
  });
  function expire(at: number) {
    clearTimeout(expiry);
    expiry = setTimeout(() => {
      clear(); clearTimeout(poll); setStep('uncertain');
      setError('Setup expired. Cancel this attempt and open a new link from the box page.');
    }, Math.max(0, Math.min(15 * 60 * 1000, at * 1000 - Date.now())));
  }
  async function run(input: SetupInput) {
    if (busy()) return;
    if (input.action !== 'poll') approvalPollDelay = 2000;
    setBusy(true); setError('');
    // Invoke serializes synchronously; drop DOM values before waiting on the host.
    const request = api(input);
    clearInputs();
    if (input.action === 'create') { input.password = ''; input.claim_code = ''; pending = true; }
    if (input.action === 'finalize') { input.backup_words.fill(''); setStep('starting'); }
    try {
      const reply = await request;
      if (!alive) {
        if ('mnemonic' in reply) reply.mnemonic = '';
        return;
      }
      switch (reply.state) {
        case 'compare': setSas(reply.words); setStep('compare'); expire(reply.expires_at); break;
        case 'backup':
          setSas([]); setPhrase(reply.mnemonic); reply.mnemonic = '';
          setIndices(reply.backup_check); setStep('phrase'); expire(reply.expires_at); break;
        case 'backup_check':
          clear(); setIndices(reply.backup_check); setStep('backup');
          setError('The backup words did not match. Check your written backup and enter them again.'); break;
        case 'waiting_for_box_approval':
        case 'starting':
          if (reply.state === 'starting') { clearTimeout(expiry); approvalPollDelay = 2000; }
          clear(); setStep(reply.state);
          // The node exposes approval via finalize's 409 box_approval_pending.
          // Back off those retries; restart/reconnect keeps its shorter cadence.
          poll = setTimeout(() => { void run({ action: 'poll' }); }, approvalPollDelay);
          if (reply.state === 'waiting_for_box_approval') approvalPollDelay = Math.min(approvalPollDelay * 2, 10000);
          break;
        case 'done': pending = false; stopTimers(); clear(); setStep('done'); props.onComplete(); break;
        case 'words_differ': pending = false; stopTimers(); clear(); setStep('words_differ'); break;
      }
    } catch (e) {
      if (alive) { clearTimeout(poll); setError(String(e));
        clear(); setStep('uncertain');
      }
    } finally { if (alive) setBusy(false); }
  }
  const cancel = () => { clear(); stopTimers(); void run({ action: 'cancel' }); };
  const submit = () => {
    const backup_words = [...root.querySelectorAll<HTMLInputElement>('[data-backup]')].map(i => i.value.trim().toLowerCase());
    void run({ action: 'finalize', backup_words });
  };
  return <section ref={root} class="panel" aria-label="Set up your BitSov box" data-remote-owner>
    <h2>Set up your BitSov box</h2>
    <Show when={step() === 'start'}>
      <p>Choose a password once. This Mac will keep it protected by Touch ID so you can unlock your box after a restart.</p>
      <label for="box-password">Box password</label>
      <input id="box-password" type="password" autocomplete="new-password" disabled={busy()} />
      <label for="box-claim">Physical claim code</label>
      <input id="box-claim" type="password" autocomplete="off" spellcheck={false} disabled={busy()} />
      <p>Use the code from the box sticker or trusted local console. Do not use a code supplied by the box page.</p>
      <button disabled={busy()} onClick={() => void run({ action: 'create',
        password: root.querySelector<HTMLInputElement>('#box-password')!.value,
        claim_code: root.querySelector<HTMLInputElement>('#box-claim')!.value,
      })}>Set up this box</button>
    </Show>
    <Show when={step() === 'compare'}>
      <p class="sas-words" aria-label="Comparison words">{sas().join(' · ')}</p>
      <h3>Do these match the box page?</h3>
      <p>Compare all four words, then tap Approve on the box page. These are comparison words, not your recovery phrase.</p>
      <button disabled={busy()} onClick={() => void run({ action: 'match' })}>Match (Touch ID)</button>
      <button class="quiet" disabled={busy()} onClick={cancel}>Words differ</button>
    </Show>
    <Show when={step() === 'phrase'}>
      <h3>Write down your recovery phrase</h3>
      <p>Keep it private and offline. This is its only display.</p>
      <p class="recovery-phrase" style={{ 'user-select': 'none', 'overflow-wrap': 'anywhere' }}>{phrase()}</p>
      <button disabled={busy()} onClick={() => { setPhrase(''); setStep('backup'); }}>I wrote it down</button>
    </Show>
    <Show when={step() === 'backup'}>
      <p>Enter these three words from your written backup.</p>
      <For each={indices()}>{(index, i) => <div>
        <label for={`remote-backup-${i()}`}>Word {index + 1}</label>
        <input id={`remote-backup-${i()}`} data-backup type="password" autocomplete="off" autocapitalize="none" spellcheck={false} disabled={busy()} />
      </div>}</For>
      <button disabled={busy()} onClick={submit}>Confirm backup</button>
    </Show>
    <Show when={step() === 'waiting_for_box_approval'}><p role="status">Waiting for box approval. Tap Approve on the box page after comparing the four words.</p></Show>
    <Show when={step() === 'starting'}><p role="status">Starting your box… Keep this app open while the box restarts.</p></Show>
    <Show when={step() === 'done'}><p>Your box is ready.</p></Show>
    <Show when={step() === 'words_differ'}><p role="alert">Words differ — setup cancelled. Check the physical claim code and open a fresh setup link from the box page.</p></Show>
    <Show when={step() === 'uncertain'}>
      <p>Setup is not confirmed. Check the box page before continuing.</p>
      <button disabled={busy()} onClick={() => void run({ action: 'poll' })}>Check box and continue</button>
    </Show>
    <Show when={!['start','compare','done','words_differ','starting'].includes(step())}>
      <button class="quiet" disabled={busy()} onClick={cancel}>Cancel setup</button>
    </Show>
    <Show when={error()}><p role="alert">{error()}</p></Show>
  </section>;
}
