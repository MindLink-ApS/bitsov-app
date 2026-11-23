import { hostText } from '../control/hostCopy';
import { t } from '../i18n';
import { deviceWord } from '../platform';
import { BoxIllustration } from './BoxIllustration';
import { PairWords } from './PairWords';
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
  /** Phone or tablet: the host has no box setup there (remote_owner_setup refuses off the Mac). */
  phone?: boolean;
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
      setError(t('obRemoteSetupExpired'));
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
          setError(t('obBackupMismatch')); break;
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
      if (alive) { clearTimeout(poll); setError(hostText(String(e)));
        clear(); setStep('uncertain');
      }
    } finally { if (alive) setBusy(false); }
  }
  const cancel = () => { clear(); stopTimers(); void run({ action: 'cancel' }); };
  const submit = () => {
    const backup_words = [...root.querySelectorAll<HTMLInputElement>('[data-backup]')].map(i => i.value.trim().toLowerCase());
    void run({ action: 'finalize', backup_words });
  };
  return <section ref={root} class="panel" aria-label={t('obSetupBox')} data-remote-owner>
    <BoxIllustration />
    <h2>{t('obSetupBox')}</h2>
    <Show when={props.phone && step() === 'start'}>
      {/* No password form here: the phone host cannot set up a box, and it has no Touch ID. */}
      <p data-remote-owner-phone>{t('obBoxNeedsMac', deviceWord() === 'iPad' ? 'iPad' : t('obPhone'))}</p>
    </Show>
    <Show when={!props.phone && step() === 'start'}>
      <p>{t('obChooseBoxPassword')}</p>
      <label for="box-password">{t('obBoxPassword')}</label>
      <input id="box-password" type="password" autocomplete="new-password" disabled={busy()} />
      <label for="box-claim">{t('obPhysicalClaim')}</label>
      <input id="box-claim" type="password" autocomplete="off" spellcheck={false} disabled={busy()} />
      <p>{t('obTrustedClaim')}</p>
      <button disabled={busy()} onClick={() => void run({ action: 'create',
        password: root.querySelector<HTMLInputElement>('#box-password')!.value,
        claim_code: root.querySelector<HTMLInputElement>('#box-claim')!.value,
      })}>{t('obSetupThisBox')}</button>
    </Show>
    <Show when={step() === 'compare'}>
      <PairWords words={sas()} />
      <h3>{t('obMatchBoxPage')}</h3>
      <p>{t('obCompareBoxWords')}</p>
      <button disabled={busy()} onClick={() => void run({ action: 'match' })}>{t('obMatchTouchId')}</button>
      <button class="quiet" disabled={busy()} onClick={cancel}>{t('obWordsDiffer')}</button>
    </Show>
    <Show when={step() === 'phrase'}>
      <h3>{t('obWriteRecovery')}</h3>
      <p>{t('obKeepRecoveryPrivate')}</p>
      <p class="recovery-phrase" style={{ 'user-select': 'none', 'overflow-wrap': 'anywhere' }}>{phrase()}</p>
      <button disabled={busy()} onClick={() => { setPhrase(''); setStep('backup'); }}>{t('obWroteItDown')}</button>
    </Show>
    <Show when={step() === 'backup'}>
      <p>{t('obEnterThree')}</p>
      <For each={indices()}>{(index, i) => <div>
        <label for={`remote-backup-${i()}`}>{t('obBackupWord', index + 1)}</label>
        <input id={`remote-backup-${i()}`} data-backup type="password" autocomplete="off" autocapitalize="none" spellcheck={false} disabled={busy()} />
      </div>}</For>
      <button disabled={busy()} onClick={submit}>{t('obConfirmBackup')}</button>
    </Show>
    <Show when={step() === 'waiting_for_box_approval'}><p role="status">{t('obWaitingBoxApproval')}</p></Show>
    <Show when={step() === 'starting'}><p role="status">{t('obStartingBox')}</p></Show>
    <Show when={step() === 'done'}><p>{t('obBoxReady')}</p></Show>
    <Show when={step() === 'words_differ'}><p role="alert">{t('obDifferentWordsCancelled')}</p></Show>
    <Show when={step() === 'uncertain'}>
      <p>{t('obBoxSetupUncertain')}</p>
      <button disabled={busy()} onClick={() => void run({ action: 'poll' })}>{t('obCheckBoxContinue')}</button>
    </Show>
    <Show when={!['start','compare','done','words_differ','starting'].includes(step())}>
      <button class="quiet" disabled={busy()} onClick={cancel}>{t('obCancelSetup')}</button>
    </Show>
    <Show when={error()}><p role="alert">{error()}</p></Show>
  </section>;
}
