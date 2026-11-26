import { setLanguagePref } from '../src/i18n';
import { DeviceApprovals } from '../src/onboarding/DeviceApprovals';
import { render } from 'solid-js/web';
import { afterEach, expect, it, vi } from 'vitest';
import { AddDevice, JoinDevice, type AddInput, type AddView, type JoinInput } from '../src/onboarding/AddDevice';
let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); document.body.innerHTML = ''; vi.useRealTimers(); setLanguagePref('system'); });
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
  expect(root.querySelector('[data-add-device-unsupported="local"]')!.textContent).toBe('This Mac runs its own box, and only this Mac can use it. To use BitSov on your phone as well, run your box on a computer or server that stays on (or one someone runs for you), and connect this Mac and your phone to it.');
  expect(root.textContent).not.toMatch(/sticker|does not support/);
  dispose?.();
  dispose = render(() => <AddDevice api={async () => ({state:'unsupported'})} />, root); await flush();
  expect(root.querySelector('[data-add-device-unsupported="node"]')!.textContent).toBe('Your box does not offer adding devices yet. A newer version of your box adds it.');
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
  // Where to go on the new device, and the code it will ask for (no box or console jargon).
  expect(root.querySelector('[data-ticket-where]')!.textContent).toContain('choose “A home node (Pi/Umbrel)” on a computer, then scan or paste this ticket');
  expect(root.querySelector('[data-ticket-claim-warning]')!.textContent).toContain('18-character claim code');
  expect(root.textContent).not.toContain('konsensus ');
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
  expect(root.textContent).toContain('18-character claim code');
  expect(root.textContent).not.toContain('konsensus ');
  expect(root.textContent).not.toMatch(/setup printed/);
  expect(root.textContent).not.toMatch(/Box claim code|trusted console/);
  expect(input.closest('label')!.textContent).toBe('Claim code');
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

it('the owner sees where adding a device stands: scan the ticket, then compare the words, then done', async () => {
  vi.useFakeTimers();
  const ticket: AddView = {state:'ticket', uri:'bitsov://pair/test', expires_at:Date.now()/1000+300, pending:[]};
  let asked = false;
  let approved = false;
  const root = mount(() => <AddDevice api={async input => {
    if (input.action === 'status') return {state:'ready', owner:true};
    if (input.action === 'approve') { approved = true; return {state:'done'}; }
    if (input.action === 'poll' && asked) return {...ticket, pending:[{op_id:'aa', name:'My phone', words, expires_at:Date.now()/1000+900}]};
    return ticket;
  }} />); await flush(); await click(root, 'Add a device');
  const steps = () => [...root.querySelectorAll('[data-pair-steps] li')].map(li => li.getAttribute('data-step-state'));
  expect(root.querySelector('[data-pair-steps]')!.getAttribute('data-pair-steps')).toBe('1');
  expect(steps()).toEqual(['current', 'todo', 'todo']);
  expect(root.querySelector('[data-pair-steps] [aria-current="step"]')!.textContent).toContain('Scan or paste the ticket');
  asked = true;
  await vi.advanceTimersByTimeAsync(2000); await flush();
  expect(steps()).toEqual(['done', 'done', 'current']);
  // The words are numbered in order, and each word's own text is unchanged.
  expect([...root.querySelectorAll('[data-pair-word]')].map(e => e.textContent)).toEqual(words);
  await click(root, 'Approve with Touch ID');
  expect(approved).toBe(true);
  expect(root.querySelector('[data-pair-steps]')!.getAttribute('data-pair-steps')).toBe('done');
  expect(steps()).toEqual(['done', 'done', 'done']);
  vi.useRealTimers();
});

it.each([
  ['expired', {uri:'bitsov://pair/old', expires_at:Date.now()/1000-1}, 'expired'],
  ['used', {uri:'', expires_at:Date.now()/1000+300}, 'was used'],
] as const)('a ticket that is %s, with no device comparing, shows no current step', async (_name, t, says) => {
  const root = mount(() => <AddDevice api={async input => input.action === 'status' ? {state:'ready', owner:true} : {state:'ticket', ...t, pending:[]}} />);
  await flush(); await click(root, 'Add a device');
  expect(root.textContent).toContain(says);
  expect(root.querySelector('[data-pair-steps]')!.getAttribute('data-pair-steps')).toBe('ended');
  expect([...root.querySelectorAll('[data-pair-steps] li')].map(li => li.getAttribute('data-step-state'))).toEqual(['todo', 'todo', 'todo']);
  expect(root.querySelector('[data-pair-steps] [aria-current]')).toBeNull();
});

it('the new device sees the same steps: the claim code next, then compare, then done', async () => {
  vi.useFakeTimers();
  let state: 'idle' | 'waiting' | 'done' = 'idle';
  const root = mount(() => <JoinDevice api={async (input: JoinInput) => {
    if (input.action === 'start') state = 'waiting';
    return state === 'waiting' ? {state:'waiting', words, expires_at:Date.now()/1000+900} : {state};
  }} />); await flush();
  const steps = () => [...root.querySelectorAll('[data-pair-steps] li')].map(li => li.getAttribute('data-step-state'));
  expect(steps()).toEqual(['done', 'current', 'todo']);
  root.querySelector<HTMLInputElement>('[name="claim_code"]')!.value = 'ABCD-EFGH-JKLM-NPQR-ST';
  root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await flush();
  expect(steps()).toEqual(['done', 'done', 'current']);
  // The owner approved: the next poll reports done.
  state = 'done';
  await vi.advanceTimersByTimeAsync(2000); await flush();
  expect(root.querySelector('[data-pair-steps]')!.getAttribute('data-pair-steps')).toBe('done');
  expect(steps()).toEqual(['done', 'done', 'done']);
  expect(root.textContent).toContain('Device added');
});

it('second-device start never renders or sends a claim code', async () => {
  const calls: JoinInput[] = [];
  const root = mount(() => <JoinDevice api={async input => {
    calls.push({...input});
    return input.action === 'start_second' ? {state:'waiting', words, expires_at:Date.now()/1000+300} : {state:'idle', second_device:true};
  }} />);
  await flush();
  expect(root.querySelector('input')).toBeNull();
  expect(root.textContent).not.toMatch(/claim code|sticker|claim-code/);
  await click(root, 'Show comparison words');
  expect(calls[calls.length - 1]).toEqual({action:'start_second'});
  expect(root.querySelectorAll('[data-pair-word]').length).toBe(4);
  expect(root.textContent).toContain('Approve on your other device');
  expect(root.textContent).not.toContain('owner console');
});

it('never flashes claim input while second-device status is loading', async () => {
  let resolve!: (v: any) => void;
  const root = mount(() => <JoinDevice api={() => new Promise(r => { resolve = r; })} />);
  expect(root.querySelector('input')).toBeNull();
  expect(root.textContent).toContain('Checking…');
  resolve({state:'idle', second_device:true}); await flush();
  expect(root.querySelector('input')).toBeNull();
  expect(root.textContent).not.toContain('Checking…');
});
it('second-device owner hides claim instructions and sends a signed rejection action', async () => {
  const calls: AddInput[] = [];
  const root = mount(() => <AddDevice mobile api={async input => {
    calls.push(input);
    if (input.action === 'reject') return {state:'rejected'};
    return {state:'ticket',second_device:true,uri:'',expires_at:Date.now()/1000+300,pending:[{op_id:'aa',name:'Phone',words,expires_at:Date.now()/1000+300,can_approve:true}]};
  }} />); await flush();
  expect(root.textContent).not.toMatch(/claim code|claim-code|sticker/);
  await click(root, 'Words differ');
  expect(calls[calls.length-1]).toEqual({action:'reject',op_id:'aa'});
  expect(root.textContent).toContain('Stopped. Nothing was added.');
});
it('another owner’s QR leaves Approve disabled with its reason', async () => {
  const root = mount(() => <AddDevice api={async () => ({state:'ticket',second_device:true,uri:'',expires_at:0,pending:[{op_id:'aa',name:'Phone',words,expires_at:Date.now()/1000+300,can_approve:false}]})} />);
  await flush();
  const approve = [...root.querySelectorAll('button')].find(b => b.textContent?.includes('Approve with'))!;
  expect(approve.disabled).toBe(true);
  expect(root.textContent).toContain('Approve on the device that showed the QR.');
});
it('says Checking until the owner device list returns', async () => {
  let resolve!: (v: AddView) => void;
  const root = mount(() => <AddDevice api={() => new Promise(r => { resolve = r; })} />);
  expect(root.textContent).toContain('Checking…');
  expect(root.textContent).not.toContain('Add a device');
  resolve({ state: 'ready', owner: true });
  await flush();
  expect(root.textContent).not.toContain('Checking…');
  expect(root.textContent).toContain('Add a device');
});
it.each(['waiting','done'] as const)('reopening a second-device join at %s never restores claim instructions', async state => {
  const root = mount(() => <JoinDevice api={async () => state === 'waiting'
    ? {state,second_device:true,words,expires_at:Date.now()/1000+300}
    : {state,second_device:true}} />);
  await flush();
  expect(root.textContent).not.toMatch(/claim code|claim-code|sticker/);
  expect(root.textContent).toContain('Prepare comparison words');
});

it.each(['en', 'da'] as const)('keeps claim entry and validation free of shell commands in %s', async lang => {
  setLanguagePref(lang);
  const root = mount(() => <JoinDevice api={async input => {
    if (input.action === 'start') throw {kind:'device_pairing', message:'Enter the 18-character claim code shown with konsensus claim-code --show.'};
    return {state:'idle'};
  }} />);
  await flush();
  expect(root.textContent).not.toContain('konsensus ');
  root.querySelector<HTMLInputElement>('[name="claim_code"]')!.value = 'typo';
  root.querySelector('form')!.dispatchEvent(new Event('submit', {bubbles:true,cancelable:true}));
  await flush();
  expect(root.querySelector('[role="alert"]')!.textContent).toContain(lang === 'en' ? '18-character claim code' : 'ejerskabskoden på 18 tegn');
  expect(root.textContent).not.toContain('konsensus ');
  expect(root.querySelector<HTMLInputElement>('[name="claim_code"]')!.value).toBe('');
});
it('a technical host error shows one plain line, with the raw text only behind Details', async () => {
  const raw = 'device_pairing_failed: POST http://127.0.0.1:9/api/v1/devices 502 {"error":"upstream"}';
  const root = mount(() => <AddDevice api={async () => { throw {message: raw}; }} />);
  await flush();
  const line = root.querySelector('[role="alert"]')!;
  expect(line.textContent).not.toContain('device_pairing_failed');
  expect(line.textContent).not.toContain('502');
  expect(root.querySelector('[data-soft-detail]')!.textContent).toContain(raw);
  expect(root.querySelector('[data-soft-detail]')!.hasAttribute('open')).toBe(false);
  // The way forward stays.
  expect([...root.querySelectorAll('button')].some(b => b.textContent?.includes('Try again'))).toBe(true);
});
it('does not render shell instructions returned by an older node', async () => {
  const root = mount(() => <AddDevice api={async () => { throw {message:'Run konsensus pair-ticket on your node.'}; }} />);
  await flush();
  expect(root.querySelector('[role="alert"]')).not.toBeNull();
  expect(root.textContent).not.toContain('konsensus ');
});

it.each([['en', 'string'], ['en', 'object'], ['da', 'string'], ['da', 'object']] as const)('retains cancel-before-retry guidance for legacy claim mismatches in %s (%s)', async (lang, shape) => {
  setLanguagePref(lang);
  const root = mount(() => <JoinDevice api={async input => {
    if (input.action === 'start') {
      const message = "The comparison could not be verified. Check the 18-character claim code with konsensus claim-code --show. Cancel the pending setup before trying again.";
      throw shape === 'string' ? message : {message};
    }
    return {state:'idle'};
  }} />);
  await flush();
  root.querySelector<HTMLInputElement>('[name="claim_code"]')!.value = 'ABCD-EFGH-JKLM-NPQR-ST';
  root.querySelector('form')!.dispatchEvent(new Event('submit', {bubbles:true,cancelable:true}));
  await flush();
  expect(root.querySelector('[role="alert"]')!.textContent).toContain(lang === 'en' ? 'Cancel the pending setup before trying again' : 'Annullér den igangværende opsætning');
  expect(root.textContent).not.toContain('konsensus ');
});
