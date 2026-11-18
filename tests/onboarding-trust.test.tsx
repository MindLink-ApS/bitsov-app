import { render } from 'solid-js/web';
import { afterEach, expect, it, vi } from 'vitest';
import App from '../src/App';
import { setLanguagePref } from '../src/i18n';

const node = 'ab'.repeat(32);
const legacyKey = `bitsov.trust.v1.remote.${node}`;
let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); document.body.innerHTML = ''; vi.unstubAllGlobals(); vi.useRealTimers(); setLanguagePref('system'); localStorage.clear(); });

function host(accepted: string | null = null, remote = true) {
  const state = { node, accepted, fail: false, remote, restoreFail: false };
  const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === 'peers_list') return [{ node_id: 'cd'.repeat(32), addr: null, label: 'Peer', connected: true }];
    if (cmd === 'messages_list') return [];
    if (cmd === 'node_status') return { ready: true, node_id: state.node, error: null };
    if (cmd === 'pairing_status') return {
      state: 'paired', remote: state.remote, scopes: ['read'], bootstrap: null,
      short_code: null, code_from_node: false, reason: null,
      trust_acknowledged_node_id: state.accepted,
    };
    if (cmd === 'trust_acknowledge') {
      if (state.fail) throw new Error('Could not save trust acknowledgement.');
      expect(args).toMatchObject({ node_id: state.node, remote: state.remote });
      state.accepted = state.node;
      return true;
    }
    if (cmd === 'identity_restore') {
      if (state.restoreFail) throw new Error('Restore refused by node.');
      return { node_id: state.node };
    }
    throw new Error('unavailable');
  });
  vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
  return { state, invoke };
}
const mount = () => { dispose = render(() => <App />, document.body); };
const gate = () => document.querySelector('[data-gate="g6-remote-trust"]');
const anyGate = () => document.querySelector('[data-gate^="g6-"]');
const summaries = () => [...document.querySelectorAll('[data-soft-summary]')].map(e => e.textContent);
const TRUST_RETRY = 'Could not save your answer. Check that your node is running, then press the button again.';
async function failTrustSave(state: { fail: boolean }) {
  state.fail = true;
  await vi.waitFor(() => expect(anyGate()).not.toBeNull());
  accept();
  await vi.waitFor(() => expect(summaries()).toContain(TRUST_RETRY));
}
async function submitRestore() {
  document.querySelector<HTMLButtonElement>('[data-restore-open]')!.click();
  await vi.waitFor(() => expect(document.querySelector('#restore-phrase')).not.toBeNull());
  const field = document.querySelector<HTMLInputElement>('#restore-phrase')!;
  field.value = 'abandon '.repeat(23) + 'art';
  field.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector<HTMLFormElement>('form.restore')!.requestSubmit();
}
const accept = () => [...document.querySelectorAll('button')].find(b => b.textContent?.includes('I understand'))!.click();

it('reinstall with existing pairing and durable acknowledgement skips trust with empty webview storage', async () => {
  host(node);
  mount();
  await vi.waitFor(() => expect(document.querySelector('[data-composer-bar]')).not.toBeNull());
  expect(gate()).toBeNull();
});

it('a new node id asks again despite the previous durable acknowledgement', async () => {
  const { state } = host(node);
  state.node = 'cd'.repeat(32);
  mount();
  await vi.waitFor(() => expect(gate()).not.toBeNull());
  expect(document.querySelector('[data-composer-bar]')).toBeNull();
});

it('fresh install asks, and accepting survives a reinstall that clears localStorage', async () => {
  const { invoke } = host();
  mount();
  await vi.waitFor(() => expect(gate()).not.toBeNull());
  accept();
  await vi.waitFor(() => expect(gate()).toBeNull());
  expect(invoke).toHaveBeenCalledWith('trust_acknowledge', { node_id: node, remote: true, legacy: false }, undefined);
  dispose!(); document.body.innerHTML = ''; localStorage.clear();
  mount();
  await vi.waitFor(() => expect(document.querySelector('[data-composer-bar]')).not.toBeNull());
  expect(gate()).toBeNull();
});

it('migrates the matching legacy flag once, only removing it after the host saves it', async () => {
  const { invoke } = host();
  localStorage.setItem(legacyKey, 'accepted');
  mount();
  await vi.waitFor(() => expect(localStorage.getItem(legacyKey)).toBeNull());
  expect(invoke).toHaveBeenCalledWith('trust_acknowledge', { node_id: node, remote: true, legacy: true }, undefined);
  dispose!(); document.body.innerHTML = '';
  mount();
  await vi.waitFor(() => expect(document.querySelector('[data-composer-bar]')).not.toBeNull());
  expect(invoke.mock.calls.filter(([cmd]) => cmd === 'trust_acknowledge')).toHaveLength(1);
});

it('retains the legacy flag and stays gated when migration cannot be saved', async () => {
  const { state } = host(); state.fail = true;
  localStorage.setItem(legacyKey, 'accepted');
  mount();
  await vi.waitFor(() => expect(gate()).not.toBeNull());
  expect(localStorage.getItem(legacyKey)).toBe('accepted');
  expect(document.querySelector('[data-composer-bar]')).toBeNull();
});

it('shows a persistence failure and allows retry before opening funding', async () => {
  const { state } = host(); state.fail = true;
  mount();
  await vi.waitFor(() => expect(gate()).not.toBeNull());
  accept();
  // A plain sentence with a next step; the raw host error stays behind Details.
  await vi.waitFor(() => expect(document.querySelector('[data-soft-summary]')?.textContent)
    .toBe('Could not save your answer. Check that your node is running, then press the button again.'));
  expect(document.querySelector('[data-soft-summary]')!.textContent).not.toContain('Error');
  expect(document.querySelector('[data-soft-summary]')!.textContent).not.toContain('acknowledgement');
  expect(document.querySelector('[data-soft-detail]')?.textContent).toContain('Could not save trust acknowledgement.');
  expect(document.querySelector<HTMLDetailsElement>('[data-soft-detail]')!.open).toBe(false);
  expect(gate()).not.toBeNull();
  state.fail = false; accept();
  await vi.waitFor(() => expect(gate()).toBeNull());
});

it.each([false, true])('a late acknowledgement cannot accept a different node (migration=%s)', async legacy => {
  vi.useFakeTimers();
  const { state, invoke } = host();
  let finish!: (accepted: boolean) => void;
  const pending = new Promise<boolean>(resolve => { finish = resolve; });
  vi.stubGlobal('__TAURI_INTERNALS__', { invoke: (cmd: string, args?: Record<string, unknown>) =>
    cmd === 'trust_acknowledge' ? pending : invoke(cmd, args),
  });
  if (legacy) localStorage.setItem(legacyKey, 'accepted');
  mount();
  await vi.advanceTimersByTimeAsync(1);
  if (!legacy) accept();
  state.node = 'ef'.repeat(32);
  await vi.advanceTimersByTimeAsync(1500);
  finish(true);
  await vi.advanceTimersByTimeAsync(1);
  expect(gate()).not.toBeNull();
  expect(document.querySelector('[data-composer-bar]')).toBeNull();
});

it('a Danish trust save failure shows the Danish message, not the raw error', async () => {
  setLanguagePref('da');
  const { state } = host(); state.fail = true;
  mount();
  await vi.waitFor(() => expect(gate()).not.toBeNull());
  [...document.querySelectorAll('button')].find(b => b.textContent?.includes('Jeg forstår'))!.click();
  await vi.waitFor(() => expect(document.querySelector('[data-soft-summary]')?.textContent)
    .toBe('Dit svar kunne ikke gemmes. Tjek at din node kører, og tryk så på knappen igen.'));
  expect(document.querySelector('[data-soft-detail]')?.textContent).toContain('Could not save trust acknowledgement.');
  expect(document.querySelector<HTMLDetailsElement>('[data-soft-detail]')!.open).toBe(false);
  expect(gate()).not.toBeNull();
});

// The phrase is shown once in the setup ceremonies (RemoteOwnerCeremony, LocalOwnerCeremony)
// and a typed restore phrase is forwarded to the node, so the disclosure must not promise
// that BitSov never shows or copies it.
const KEYS_EN = 'Your keys stay in the node. BitSov shows a new recovery phrase only once, during setup, so you can write it down. A phrase you type to restore goes straight to the node. The app keeps no copy.';
const KEYS_DA = 'Dine nøgler bliver i noden. BitSov viser en ny gendannelsessætning kun én gang, under opsætningen, så du kan skrive den ned. En sætning, du skriver for at gendanne, går direkte til noden. Appen gemmer ingen kopi.';

it.each([true, false])('the English G6 disclosure describes the one-time phrase display, not a never-shown promise (remote=%s)', async remote => {
  setLanguagePref('en');
  host(null, remote);
  mount();
  const selector = `[data-gate="g6-${remote ? 'remote' : 'local'}-trust"]`;
  await vi.waitFor(() => expect(document.querySelector(selector)).not.toBeNull());
  const text = document.querySelector(selector)!.textContent!.replace(/\s+/g, ' ');
  expect(text).toContain(KEYS_EN);
  expect(text).not.toContain('never shows you your recovery phrase');
  expect(text).not.toContain('never copies it');
});

it.each([true, false])('renders the G6 disclosure and its button in Danish (remote=%s)', async remote => {
  setLanguagePref('da');
  host(null, remote);
  mount();
  const selector = `[data-gate="g6-${remote ? 'remote' : 'local'}-trust"]`;
  await vi.waitFor(() => expect(document.querySelector(selector)).not.toBeNull());
  const disclosure = document.querySelector(selector)!;
  const text = disclosure.textContent!.replace(/\s+/g, ' ');
  if (remote) {
    expect(disclosure.querySelector('h2')!.textContent).toBe('Tillid til fjernnoden — læs dette, før du indsætter penge');
    expect(text).toContain('Denne nodes nøgler ligger på fjernmaskinen. Alle med adgang — alle, der kan logge ind på den computer — kan bruge det, du indsætter. Indsæt kun penge på en node, hvis vært du stoler på.');
  } else {
    expect(disclosure.querySelector('h2')!.textContent).toBe('Lokal tillid — læs dette, før du indsætter penge');
    expect(text).toContain('Din node kan kun nås, mens denne Mac er vågen, og BitSov er åben.');
    expect(text).toContain('Denne node stoler på alle programmer på denne computer. Alt, der kører under din brugerkonto, kan bede den om fuld adgang via 127.0.0.1 — nok til at bruge det, du indsætter, og læse din historik. Indsæt kun penge på en node på en maskine, du selv styrer.');
    expect(disclosure.querySelector('code')!.textContent).toBe('127.0.0.1');
  }
  expect(text).toContain(KEYS_DA);
  expect(text).not.toContain('viser dig aldrig');
  for (const english of ['read this before you deposit', 'Your keys stay in the node', 'Only fund a node']) expect(text).not.toContain(english);
  const buttons = [...document.querySelectorAll('button')].map(b => b.textContent?.trim());
  expect(buttons).toContain('Jeg forstår — fortsæt til indbetaling');
  expect(buttons).not.toContain('I understand — continue to funding');
});

it('a successful restore clears an earlier failed trust save', async () => {
  const { state } = host();
  mount();
  await failTrustSave(state);
  await submitRestore();
  await vi.waitFor(() => expect(document.querySelector('.ok-note')).not.toBeNull());
  expect(summaries()).not.toContain(TRUST_RETRY);
  expect(document.querySelector('[data-soft-detail]')).toBeNull();
  expect(anyGate()).not.toBeNull();
});

it('a failed restore after a failed trust save shows only the restore error', async () => {
  const { state } = host();
  mount();
  await failTrustSave(state);
  state.restoreFail = true;
  await submitRestore();
  await vi.waitFor(() => expect(summaries().some(s => s !== TRUST_RETRY)).toBe(true));
  expect(summaries()).toHaveLength(1);
  expect(summaries()).not.toContain(TRUST_RETRY);
});

it.each(['mode', 'node'] as const)('a new trust boundary (%s) drops the earlier failed trust save', async change => {
  const { state } = host();
  mount();
  await failTrustSave(state);
  if (change === 'mode') state.remote = false;
  else state.node = 'cd'.repeat(32);
  const next = change === 'mode' ? '[data-gate="g6-local-trust"]' : '[data-gate="g6-remote-trust"]';
  await vi.waitFor(() => {
    expect(document.querySelector(next)).not.toBeNull();
    if (change === 'node') expect(document.querySelector('.node-id')!.getAttribute('title')).toBe(state.node);
  }, { timeout: 4000 });
  expect(summaries()).not.toContain(TRUST_RETRY);
});

it('a failed trust save survives status polls that keep the same mode and node id', async () => {
  vi.useFakeTimers();
  const { state, invoke } = host();
  mount();
  await vi.advanceTimersByTimeAsync(1);
  state.fail = true;
  accept();
  await vi.advanceTimersByTimeAsync(1);
  expect(summaries()).toContain(TRUST_RETRY);
  const polls = () => invoke.mock.calls.filter(([cmd]) => cmd === 'node_status').length;
  const before = polls();
  // Every poll hands the gate fresh status and pairing objects with the same values.
  await vi.advanceTimersByTimeAsync(1500 * 4);
  expect(polls()).toBeGreaterThanOrEqual(before + 3);
  expect(summaries()).toContain(TRUST_RETRY);
  expect(anyGate()).not.toBeNull();
});

it('a node id that is briefly missing on a poll is not a new trust boundary', async () => {
  vi.useFakeTimers();
  const { state } = host();
  mount();
  await vi.advanceTimersByTimeAsync(1);
  state.fail = true;
  accept();
  await vi.advanceTimersByTimeAsync(1);
  expect(summaries()).toContain(TRUST_RETRY);
  state.node = null as unknown as string;
  await vi.advanceTimersByTimeAsync(1500);
  state.node = 'AB'.repeat(32);
  await vi.advanceTimersByTimeAsync(1500 * 2);
  expect(anyGate()).not.toBeNull();
  expect(summaries()).toContain(TRUST_RETRY);
});

it('a trust save that fails after a restore cleared the gate does not bring its error back', async () => {
  const { state, invoke } = host();
  let fail!: (error: Error) => void;
  const pending = new Promise<boolean>((_, reject) => { fail = reject; });
  vi.stubGlobal('__TAURI_INTERNALS__', { invoke: (cmd: string, args?: Record<string, unknown>) =>
    cmd === 'trust_acknowledge' ? pending : invoke(cmd, args),
  });
  mount();
  await vi.waitFor(() => expect(anyGate()).not.toBeNull());
  accept();
  await submitRestore();
  await vi.waitFor(() => expect(document.querySelector('.ok-note')).not.toBeNull());
  fail(new Error('Could not save trust acknowledgement.'));
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(summaries()).not.toContain(TRUST_RETRY);
  expect(document.querySelector('[data-soft-detail]')).toBeNull();
  expect(anyGate()).not.toBeNull();
  expect(state.accepted).toBeNull();
});

it('a trust save that fails after the mode changed does not show on the new gate', async () => {
  const { state, invoke } = host();
  let fail!: (error: Error) => void;
  const pending = new Promise<boolean>((_, reject) => { fail = reject; });
  vi.stubGlobal('__TAURI_INTERNALS__', { invoke: (cmd: string, args?: Record<string, unknown>) =>
    cmd === 'trust_acknowledge' ? pending : invoke(cmd, args),
  });
  mount();
  await vi.waitFor(() => expect(gate()).not.toBeNull());
  accept();
  state.remote = false;
  await vi.waitFor(() => expect(document.querySelector('[data-gate="g6-local-trust"]')).not.toBeNull(), { timeout: 4000 });
  fail(new Error('Could not save trust acknowledgement.'));
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(summaries()).not.toContain(TRUST_RETRY);
  expect(document.querySelector('[data-gate="g6-local-trust"]')).not.toBeNull();
});
