import { DeviceApprovals } from '../src/onboarding/DeviceApprovals';
import { render } from 'solid-js/web';
import { afterEach, expect, it, vi } from 'vitest';
import { AddDevice, JoinDevice, type AddInput, type AddView, type JoinInput } from '../src/onboarding/AddDevice';
let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); document.body.innerHTML = ''; vi.useRealTimers(); });
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
const words = ['noodle', 'gallery', 'demand', 'science'];
function mount(ui: () => any) { const root = document.createElement('div'); document.body.append(root); dispose = render(ui, root); return root; }
async function click(root: HTMLElement, text: string) { const b = [...root.querySelectorAll('button')].find(b => b.textContent?.includes(text)); expect(b).toBeTruthy(); b!.click(); await flush(); }
it('hides Add a device on older nodes and explains non-owner pairings', async () => {
  const root = mount(() => <AddDevice api={async () => ({state:'unsupported'})} />); await flush();
  expect(root.textContent).not.toContain('Add a device'); dispose?.();
  dispose = render(() => <AddDevice api={async () => ({state:'ready', owner:false})} />, root); await flush();
  expect(root.textContent).toContain('enrolled owner device');
  expect(root.querySelector('button')).toBeNull();
});
it('a node on this Mac says why it cannot add a phone; an older remote node says an update adds it', async () => {
  const root = mount(() => <AddDevice local api={async () => ({state:'unsupported'})} />); await flush();
  expect(root.querySelector('[data-add-device-unsupported="local"]')!.textContent).toBe('This Mac runs its own node, and only this Mac can use it. To use BitSov on your phone as well, run your node on a computer or server that stays on (or one someone runs for you), and connect this Mac and your phone to it.');
  expect(root.textContent).not.toMatch(/box|sticker|does not support/);
  dispose?.();
  dispose = render(() => <AddDevice api={async () => ({state:'unsupported'})} />, root); await flush();
  expect(root.querySelector('[data-add-device-unsupported="node"]')!.textContent).toBe('Your node does not offer adding devices yet. A newer version of your node adds it.');
});
it('shows the QR, polls for SAS and never approves without an explicit tap', async () => {
  vi.useFakeTimers(); const calls: AddInput[] = [];
  const ticket: AddView = {state:'ticket', uri:'bitsov://pair/test', expires_at:Date.now()/1000+300, pending:[]};
  const root = mount(() => <AddDevice api={async input => { calls.push(input);
    if (input.action === 'status') return {state:'ready', owner:true};
    if (input.action === 'approve') return {state:'done'};
    return input.action === 'poll' ? {...ticket, pending:[{op_id:'aa', name:'My phone', words, expires_at:Date.now()/1000+900}]} : ticket;
  }} />); await flush(); await click(root, 'Add a device');
  expect(root.querySelector('svg[role="img"]')).not.toBeNull();
  expect(root.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('bitsov://pair/test');
  await vi.advanceTimersByTimeAsync(2000); await flush();
  expect([...root.querySelectorAll('[data-pair-word]')].map(e => e.textContent)).toEqual(words);
  expect(calls.some(c => c.action === 'approve')).toBe(false);
  await click(root, 'Approve with Touch ID');
  expect(calls[calls.length - 1]).toEqual({action:'approve', op_id:'aa'});
  expect(root.textContent).toContain('Device added');
  expect(root.textContent).not.toContain('bitsov://pair');
});
it('removes expired QR authority while retaining comparison for a ticket already consumed', async () => {
  vi.useFakeTimers();
  const root = mount(() => <AddDevice api={async input => input.action === 'status' ? {state:'ready',owner:true} : {state:'ticket',uri:'bitsov://pair/expired',expires_at:Date.now()/1000-1,pending:[]}} />);
  await flush(); await click(root, 'Add a device');
  expect(root.querySelector('svg')).toBeNull(); expect(root.textContent).toContain('expired');
  expect(root.textContent).not.toContain('bitsov://pair/expired');
});
it('words differ drops the ticket and comparison without an approval', async () => {
  const calls: AddInput[] = [];
  const root = mount(() => <AddDevice api={async input => { calls.push(input); return input.action === 'status' || input.action === 'cancel' ? {state:'ready',owner:true} : {state:'ticket',uri:'bitsov://pair/secret',expires_at:Date.now()/1000+300,pending:[{op_id:'aa',name:'Phone',words,expires_at:Date.now()/1000+900}]}; }} />);
  await flush(); await click(root, 'Add a device'); await click(root, 'Words differ');
  expect(calls.map(c => c.action)).toEqual(['status','mint','cancel']);
  expect(root.textContent).not.toContain('gallery'); expect(root.textContent).not.toContain('bitsov://pair/secret');
});
it('joining clears the claim code, shows SAS while waiting and polls enrollment', async () => {
  vi.useFakeTimers(); const calls: string[] = []; let submitted = '';
  const root = mount(() => <JoinDevice api={async (input: JoinInput) => { calls.push(input.action);
    if(input.action === 'start') { submitted = input.claim_code; return {state:'waiting',words,expires_at:Date.now()/1000+900}; }
    return input.action === 'poll' ? {state:'done'} : {state:'idle'};
  }} />); await flush();
  const input = root.querySelector<HTMLInputElement>('[name="claim_code"]')!;
  input.value = 'physical sticker'; await click(root, 'Show comparison words');
  expect(submitted).toBe('physical sticker'); expect(input.value).toBe('');
  expect(root.textContent).toContain('gallery'); expect(root.textContent).toContain('owner device');
  await vi.advanceTimersByTimeAsync(2000); await flush();
  expect(root.textContent).toContain('Device added'); expect(calls).toEqual(['status','start','poll']);
});
it('surfaces cancellation errors without claiming the request was withdrawn', async () => {
  const root = mount(() => <JoinDevice api={async input => { if(input.action === 'cancel') throw {message:'Could not cancel. The request may still be approved.'}; return {state:'waiting',words,expires_at:Date.now()/1000+900}; }} />); await flush();
  await click(root, 'Words differ'); expect(root.querySelector('[role="alert"]')?.textContent).toContain('may still be approved');
});
it('does not render an empty QR after a consumed ticket has no pending operation', async () => {
  const root = mount(() => <AddDevice api={async input => input.action === 'status' ? {state:'ready',owner:true} : {state:'ticket',uri:'',expires_at:Date.now()/1000+300,pending:[]}} />);
  await flush(); await click(root,'Add a device');
  expect(root.querySelector('svg')).toBeNull(); expect(root.querySelector('textarea')).toBeNull();
  expect(root.textContent).toContain('used');
});

it('fresh paired installs use the SAS joining flow instead of legacy console registration', async () => {
  const legacy = vi.fn();
  const root = mount(() => <DeviceApprovals remote mobile device={{available:true,state:'none',fingerprint:null,owner_action:null,expires_at_ms:null,delegation_supported:true}}
    onRegister={legacy} onCancel={async () => {}} joinDevice={async () => ({state:'idle'})} />);
  await flush();
  expect(root.querySelector('[data-join-device]')).not.toBeNull();
  expect(root.querySelector('[name="claim_code"]')).not.toBeNull();
  expect(root.querySelector('[data-device-register]')).toBeNull();
  expect(legacy).not.toHaveBeenCalled();
});
it('does not keep polling after the owner view is disposed or auto-approve a late response', async () => {
  vi.useFakeTimers(); let resolve!: (v:AddView)=>void; const calls: string[] = [];
  const root = mount(() => <AddDevice api={async input => { calls.push(input.action); if(input.action==='status') return {state:'ready',owner:true}; return new Promise<AddView>(r=>{resolve=r;}); }} />);
  await flush(); await click(root,'Add a device'); dispose?.();
  resolve({state:'ticket',uri:'bitsov://pair/secret',expires_at:Date.now()/1000+300,pending:[]}); await flush();
  await vi.advanceTimersByTimeAsync(10000);
  expect(calls).toEqual(['status','mint']); expect(root.textContent).not.toContain('secret');
});
it('warns an enrolled device when it is the only owner key', async () => {
  const root = mount(() => <DeviceApprovals remote showRegistered device={{available:true,state:'registered',fingerprint:null,owner_action:null,expires_at_ms:null,owner_device_count:1}}
    onRegister={async()=>{}} onCancel={async()=>{}} />);
  expect(root.textContent).toContain('only owner device');
});
