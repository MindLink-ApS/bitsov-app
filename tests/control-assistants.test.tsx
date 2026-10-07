import { afterEach, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { AiTrack, createAiSession } from '../src/control/AiTrack';
import { sampleSource } from '../src/control/sample';
import type { Source } from '../src/control/source';
import type { Disclosure } from '../src/control/types';

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

it('cancels a local preview that finishes after leaving the assistant', async () => {
  const source = sampleSource();
  let finish!: (d: Disclosure) => void;
  const cancelled: string[] = [];
  const own = { kind: 'local' as const, label: 'On this computer', enabled: true, host: '127.0.0.1:11434', model: 'local', note: null, pays: { to: null, rail: 'none' as const }, data_leaves: null };
  source.aiProviders = async () => [own];
  source.aiDisclose = async (_provider, _topic, _since, _preset, _question, assistant) => {
    expect(assistant).toBe('inbox');
    return new Promise(resolve => { finish = resolve; });
  };
  source.aiCancel = async id => { cancelled.push(id); return true; };
  await open(source);
  await ask('who messaged me?');
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  dispose!(); dispose = undefined;
  finish({ id: 'late', provider: 'local', label: 'Own', host: '127.0.0.1:11434', model: 'local', preset: 'counts', body: '{}', bytes: 2, key_env: null, expires_in_ms: 300000 });
  await vi.waitFor(() => expect(cancelled).toEqual(['late']));
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
