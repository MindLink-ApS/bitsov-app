import { render } from 'solid-js/web';
import { afterEach, expect, it, vi } from 'vitest';
import { RemoteOwnerCeremony, type SetupInput, type SetupView } from '../src/onboarding/RemoteOwnerCeremony';
let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); document.body.innerHTML = ''; vi.useRealTimers(); });
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function mount(api: (input: SetupInput) => Promise<SetupView>) {
  const root = document.createElement('div'); document.body.append(root);
  dispose = render(() => <RemoteOwnerCeremony api={api} onComplete={() => {}} />, root);
  return root;
}
function click(root: HTMLElement, text: string) {
  const button = [...root.querySelectorAll('button')].find(b => b.textContent?.includes(text));
  expect(button).toBeTruthy(); button!.click();
}
async function start(root: HTMLElement) {
  const password = root.querySelector<HTMLInputElement>('#box-password')!;
  const claim = root.querySelector<HTMLInputElement>('#box-claim')!;
  password.value = 'chosen password'; claim.value = 'physical claim code';
  click(root, 'Set up this box'); await flush();
}
it('clears submitted secrets and never matches or finalizes automatically', async () => {
  const calls: string[] = [];
  let sent: SetupInput | undefined;
  const root = mount(async input => { calls.push(input.action); sent = input;
    return { state: 'compare', words: ['noodle','gallery','demand','science'], expires_at: Date.now()/1000+600 }; });
  await start(root);
  expect(calls).toEqual(['create']);
  expect(sent).toEqual({ action: 'create', password: '', claim_code: '' });
  expect(root.textContent).toContain('Do these match the box page?');
  expect([...root.querySelectorAll('[data-pair-word]')].map(el => el.textContent)).toEqual(['noodle', 'gallery', 'demand', 'science']);
  expect(root.querySelector('[data-box-illustration]')).not.toBeNull();
  expect(root.querySelector('#box-password')).toBeNull();
  await flush(); expect(calls).toEqual(['create']);
});
it('Words differ cancels without requesting a signature or sending backup words', async () => {
  const calls: string[] = [];
  const root = mount(async input => { calls.push(input.action);
    return input.action === 'create'
      ? { state:'compare', words:['noodle','gallery','demand','science'], expires_at:Date.now()/1000+600 }
      : { state:'words_differ' }; });
  await start(root); click(root, 'Words differ'); await flush();
  expect(calls).toEqual(['create','cancel']);
  expect(root.textContent).toContain('Words differ');
  expect(root.textContent).not.toContain('gallery');
});
it('reveals backup only after Match and polls only a submitted confirmation awaiting box approval', async () => {
  vi.useFakeTimers();
  const calls: string[] = [];
  const root = mount(async input => { calls.push(input.action);
    if(input.action==='create') return {state:'compare',words:['noodle','gallery','demand','science'],expires_at:Date.now()/1000+600};
    if(input.action==='match') return {state:'backup',mnemonic:'one two three four five six seven eight nine ten eleven twelve',backup_check:[0,4,9],expires_at:Date.now()/1000+600};
    if(input.action==='finalize') return {state:'waiting_for_box_approval'};
    return {state:'done'};
  });
  await start(root); click(root, 'Match'); await flush();
  expect(root.textContent).toContain('one two three');
  click(root, 'I wrote it down'); await flush();
  expect(root.textContent).not.toContain('one two three');
  const inputs = root.querySelectorAll<HTMLInputElement>('[data-backup]');
  ['one','five','ten'].forEach((word,i)=> {inputs[i].value=word;});
  click(root, 'Confirm backup'); await flush();
  expect(root.textContent).toContain('Waiting for box approval');
  expect(calls).toEqual(['create','match','finalize']);
  await vi.advanceTimersByTimeAsync(2000);
  expect(calls).toEqual(['create','match','finalize','poll']);
  expect(root.textContent).toContain('ready');
});
it('shows closed/restarted errors without starting a fresh ceremony automatically', async () => {
  const api = vi.fn(async () => {throw new Error('Setup closed after three failed attempts. Restart the box.');});
  const root = mount(api); await start(root);
  expect(root.textContent).toContain('Setup closed'); expect(api).toHaveBeenCalledTimes(1);
});
it('asks for corrected backup words instead of polling the same failed check', async () => {
  vi.useFakeTimers(); const calls: string[]=[];
  const root=mount(async input=>{calls.push(input.action);
    if(input.action==='create')return {state:'compare',words:['a','b','c','d'],expires_at:Date.now()/1000+600};
    if(input.action==='match')return {state:'backup',mnemonic:'one two three four five six seven eight nine ten eleven twelve',backup_check:[0,4,9],expires_at:Date.now()/1000+600};
    return {state:'backup_check',backup_check:[0,4,9]};
  });
  await start(root);click(root,'Match');await flush();click(root,'I wrote it down');
  click(root,'Confirm backup');await flush();
  expect(root.querySelectorAll('[data-backup]')).toHaveLength(3);
  expect(root.textContent).toContain('did not match');
  await vi.advanceTimersByTimeAsync(6000);
  expect(calls).toEqual(['create','match','finalize']);
});

it('recovers a lost finalize reply through an explicit poll without replaying confirmation', async () => {
  vi.useFakeTimers();
  const calls: string[] = [];
  const root = mount(async input => {
    calls.push(input.action);
    if (input.action === 'create') return { state: 'compare', words: ['a','b','c','d'], expires_at: Date.now()/1000+600 };
    if (input.action === 'match') return { state: 'backup', mnemonic: 'one two three four five six seven eight nine ten eleven twelve', backup_check: [0,4,9], expires_at: Date.now()/1000+600 };
    if (input.action === 'finalize') throw new Error('The finalize reply was lost. Check the box and continue.');
    return { state: 'done' };
  });
  await start(root); click(root, 'Match'); await flush();
  click(root, 'I wrote it down'); click(root, 'Confirm backup'); await flush();
  expect(root.textContent).toContain('finalize reply was lost');
  expect(root.querySelectorAll('[data-backup]')).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(6000);
  expect(calls).toEqual(['create', 'match', 'finalize']);
  click(root, 'Check box and continue'); await flush();
  expect(calls).toEqual(['create', 'match', 'finalize', 'poll']);
  expect(root.textContent).toContain('ready');
});

it('backs approval polling off to ten seconds and stops once finalized', async () => {
  vi.useFakeTimers();
  const calls: string[] = [];
  let approved = false;
  const root = mount(async input => {
    calls.push(input.action);
    if (input.action === 'create') return { state: 'compare', words: ['a','b','c','d'], expires_at: Date.now()/1000+600 };
    if (input.action === 'match') return { state: 'backup', mnemonic: 'one two three four five six seven eight nine ten eleven twelve', backup_check: [0,4,9], expires_at: Date.now()/1000+600 };
    return { state: approved ? 'done' : 'waiting_for_box_approval' };
  });
  await start(root); click(root, 'Match'); await flush();
  click(root, 'I wrote it down'); click(root, 'Confirm backup'); await flush();
  for (const delay of [2000, 4000, 8000, 10000, 10000]) {
    const before = calls.length;
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(calls).toHaveLength(before);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(before + 1);
    expect(calls[calls.length - 1]).toBe('poll');
  }
  approved = true;
  await vi.advanceTimersByTimeAsync(10000);
  expect(root.textContent).toContain('ready');
  const finished = calls.length;
  await vi.advanceTimersByTimeAsync(30000);
  expect(calls).toHaveLength(finished);
  expect(calls.filter(action => action === 'finalize')).toHaveLength(1);
});

it('clears comparison and offers cancellation when Match aborts the host attempt', async () => {
  const calls: string[] = [];
  const root = mount(async input => {
    calls.push(input.action);
    if (input.action === 'create') return { state: 'compare', words: ['noodle','gallery','demand','science'], expires_at: Date.now()/1000+600 };
    if (input.action === 'match') throw new Error('Touch ID cancelled.');
    return { state: 'words_differ' };
  });
  await start(root); click(root, 'Match'); await flush();
  expect(root.textContent).toContain('Touch ID cancelled');
  expect(root.textContent).not.toContain('noodle');
  expect(root.textContent).not.toContain('Match (Touch ID)');
  click(root, 'Cancel setup'); await flush();
  expect(calls).toEqual(['create', 'match', 'cancel']);
});
