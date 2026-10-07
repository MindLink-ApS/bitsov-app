import { afterEach, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { AiTrack, createAiSession } from '../src/control/AiTrack';
import { sampleSource } from '../src/control/sample';
import type { Source } from '../src/control/source';

let dispose: (() => void) | undefined;
let mount: HTMLDivElement;
afterEach(() => { dispose?.(); dispose = undefined; mount?.remove(); });
const $ = <T extends Element = HTMLElement>(sel: string) => mount.querySelector<T>(sel)!;
async function open(source: Source) {
  mount = document.createElement('div');
  document.body.appendChild(mount);
  dispose = render(() => <AiTrack source={source} session={createAiSession()} assistant="inbox"
    peers={[]} now={Date.now()} onPrefill={() => { throw new Error('Drafts are forbidden'); }} onContext={() => {}}
    head={(title, sub) => <header>{title}{sub}</header>} />, mount);
  await vi.waitFor(() => expect($('[data-assistant-ready]')).not.toBeNull());
}
async function ask(text: string) {
  const input = $<HTMLTextAreaElement>('[data-ai-input]');
  input.value = text; input.dispatchEvent(new Event('input', { bubbles: true }));
  await vi.waitFor(() => expect($<HTMLButtonElement>('[data-ai-ask]').disabled).toBe(false));
  $<HTMLButtonElement>('[data-ai-ask]').click();
}

it('unknown questions describe only the named assistant’s shipped read-only role', async () => {
  await open(sampleSource());
  await ask('tell me a joke');
  await vi.waitFor(() => expect($('[data-ai-text]')).not.toBeNull());
  expect($('[data-ai-text]').textContent).toContain('Inbox counts only');
  expect($('[data-ai-text]').textContent).not.toContain('I can draft');
});

it('renders local model proposals as inert drafts and sends no action', async () => {
  const source = sampleSource();
  const own = { kind: 'local' as const, label: 'On this computer', enabled: true, host: '127.0.0.1:11434', model: 'local', note: null, pays: { to: null, rail: 'none' as const }, data_leaves: null };
  source.aiProviders = async () => [own];
  source.aiLocalTurn = vi.fn(async () => ({ output: { kind: 'proposal' as const, proposal: { kind: 'message' as const, recipient: '11'.repeat(32), draft_text: 'hello' } }, reads: [] }));
  source.aiDisclose = vi.fn();
  source.aiSend = vi.fn();
  await open(source);
  expect($('[data-ai-ask]').getAttribute('aria-label')).toBe('Ask');
  expect($('[data-ai-policy]').textContent).toContain('display-only');
  expect($('.ai-hero').textContent).not.toContain('preview each request');
  await ask('draft a message');
  await vi.waitFor(() => expect($('[data-model-proposal]')).not.toBeNull());
  expect($('[data-model-proposal]').textContent).toContain('hello');
  expect($('[data-model-proposal]').textContent).toContain('11'.repeat(32));
  expect($('[data-ai-prefill]')).toBeNull();
  expect(source.aiLocalTurn).toHaveBeenCalledWith('inbox', 'draft a message', '');
  expect(source.aiDisclose).not.toHaveBeenCalled();
  expect(source.aiSend).not.toHaveBeenCalled();
  await vi.waitFor(async () => expect((await source.aiThread('inbox', { action: 'load' })).turns[0].answer).toContain('hello'));
});

it('shows a host loop failure without falling back to prose or dispatch', async () => {
  const source = sampleSource();
  source.aiProviders = async () => [{ kind: 'local', label: 'Own', enabled: true, host: '127.0.0.1:11434', model: 'local', note: null, pays: { to: null, rail: 'none' }, data_leaves: null }];
  source.aiLocalTurn = async () => { throw new Error('The local model returned an invalid answer. Nothing was done.'); };
  await open(source);
  await ask('anything outside the rules parser');
  await vi.waitFor(() => expect($('[data-ai-answer="error"]')).not.toBeNull());
  expect($('[data-model-proposal]')).toBeNull();
  expect($('[data-ai-prefill]')).toBeNull();
});

it.each(['old-first', 'new-first'])('saves both answers when reopening during a read: %s', async order => {
  const source = sampleSource();
  const read = source.aiRead;
  const finish: (() => Promise<void>)[] = [];
  source.aiRead = async (topic, since, assistant) => new Promise(resolve => {
    finish.push(async () => resolve(await read(topic, since, assistant)));
  });
  await open(source);
  await ask('who messaged me?');
  await vi.waitFor(() => expect(finish).toHaveLength(1));
  dispose!(); dispose = undefined; mount.remove();
  await open(source);
  await ask('who messaged me?');
  await vi.waitFor(() => expect(finish).toHaveLength(2));
  const first = order === 'old-first' ? 0 : 1;
  await finish[first]();
  await vi.waitFor(async () => expect((await source.aiThread('inbox', { action: 'load' })).turns).toHaveLength(1));
  await finish[1 - first]();
  await vi.waitFor(async () => expect((await source.aiThread('inbox', { action: 'load' })).turns).toHaveLength(2));
  expect($('[data-assistant-error]')).toBeNull();
  expect($('[data-assistant-ready]')).not.toBeNull();
});

it('passes separately entered message text verbatim to the local host', async () => {
  const source = sampleSource();
  source.aiProviders = async () => [{ kind: 'local', label: 'Own', enabled: true, host: '127.0.0.1:11434', model: 'local', note: null, pays: { to: null, rail: 'none' }, data_leaves: null }];
  source.aiLocalTurn = vi.fn(async () => ({ output: { kind: 'answer' as const, text: 'Draft unavailable', topics: [] }, reads: [] }));
  await open(source);
  await vi.waitFor(() => expect($('[data-ai-draft-text]')).not.toBeNull());
  const input = $<HTMLTextAreaElement>('[data-ai-draft-text]');
  input.value = 'Hello, exactly this.\nThank you.';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await ask('draft this message');
  await vi.waitFor(() => expect(source.aiLocalTurn).toHaveBeenCalledWith('inbox', 'draft this message', 'Hello, exactly this.\nThank you.'));
});

it('offers scoped watch switches, persists off, and Forget leaves the switch off', async () => {
  const source = sampleSource();
  await open(source);
  const box = $<HTMLInputElement>('[data-watch="unread"]');
  expect(box).not.toBeNull();
  expect(box.checked).toBe(true);
  expect($('[data-watch="balance_drop"]')).toBeNull();
  box.click();
  await vi.waitFor(async () => expect((await source.aiThread('inbox', { action: 'load' })).disabled_watches).toEqual(['unread']));
  $<HTMLButtonElement>('[data-assistant-forget]').click();
  await vi.waitFor(() => expect(box.disabled).toBe(false));
  expect(box.checked).toBe(false);
});

it('renders sealed watch notices as text with no draft or action control', async () => {
  const source = sampleSource();
  const thread = source.aiThread;
  source.aiThread = async (a, r) => ({ ...await thread(a, r), notices: [{ at: 42, rule: 'unread', text: 'Unread count rose from 1 to 2.' }] });
  await open(source);
  expect($('[data-watch-notice]')?.textContent).toContain('Unread count rose');
  expect($('[data-watch-notice]')?.querySelector('button')).toBeNull();
  expect($('[data-ai-prefill]')).toBeNull();
  expect($('[data-model-proposal]')).toBeNull();
});
