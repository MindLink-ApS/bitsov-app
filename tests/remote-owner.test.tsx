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
  expect(root.textContent).toContain('noodle');
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
