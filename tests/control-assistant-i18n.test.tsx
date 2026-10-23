import { afterEach, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { setLanguagePref } from '../src/i18n';
import { ASSISTANTS } from '../src/control/assistants';
import { SUGGESTIONS, understand } from '../src/control/ai';
import { GATE_WORDS } from '../src/control/body';
import { messagesWorth } from '../src/control/state';
import { sampleSource, SAMPLE_PEERS } from '../src/control/sample';
import { endpointBadge, OWN_RULES } from '../src/assistant/endpoint';
import { AssistantPage } from '../src/assistant/Page';
import { QUESTIONS } from '../src/assistant/questions';
import { freshnessText } from '../src/assistant/source';
import { connectionSummary } from '../src/control/ConnectionCard';
import { startRecording } from '../src/control/voice';
import { softenError } from '../src/control/userFacing';
import { amount, groupDigits } from '../src/control/format';
import { termLines, approvalReason, type ApprovalView } from '../src/control/ownerApproval';

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; document.body.innerHTML = ''; setLanguagePref('system'); vi.restoreAllMocks(); });

it('switches an already-mounted assistant, questions, labels and source copy', () => {
  setLanguagePref('en');
  dispose = render(() => <AssistantPage view={{ rows: [{ id: 'q01', answer: 'Unavailable' }], source: { kind: 'mock', reason: 'not_paired' }, freshness: null }} />, document.body);
  expect(document.body.textContent).toContain('What is the local balance');
  setLanguagePref('da');
  expect(document.body.textContent).toContain('Hvad er den lokale saldo');
  expect(document.body.textContent).toContain('Eksempeldata');
  expect(document.body.textContent).toContain('Ikke tilgængelig');
  expect(document.body.textContent).toContain('Kopiér');
  expect(QUESTIONS.every(q => !q.text.startsWith('What ') && !q.text.startsWith('How '))).toBe(true);
  setLanguagePref('en');
  expect(document.body.textContent).toContain('What is the local balance');
});

it('keeps the meanings of built-in assistant suggestions in Danish', () => {
  const now = Date.UTC(2026, 9, 23);
  setLanguagePref('en');
  const english = [...SUGGESTIONS(), ...Object.values(ASSISTANTS).flatMap(a => a.suggestions)];
  const expected = english.map(q => understand(q, SAMPLE_PEERS, now));
  setLanguagePref('da');
  const danish = [...SUGGESTIONS(), ...Object.values(ASSISTANTS).flatMap(a => a.suggestions)];
  expect(ASSISTANTS.wallet.name).toBe('Tegnebog');
  expect(danish).not.toEqual(english);
  danish.forEach((q, i) => {
    const actual = understand(q, SAMPLE_PEERS, now);
    // Display labels change language; topic, dates, recipient and draft stay identical.
    if (actual.kind === 'read' && expected[i].kind === 'read') expect({ ...actual, window: null }).toEqual({ ...expected[i], window: null });
    else if (actual.kind === 'act' && expected[i].kind === 'act') expect({ ...actual.proposal, name: null }).toEqual({ ...expected[i].proposal, name: null });
    else expect(actual).toEqual(expected[i]);
    expect(actual.kind).not.toBe('unknown');
  });
});

it('localizes helper copy at read time and uses Danish device and plural words', () => {
  setLanguagePref('en');
  expect(messagesWorth(2000, 1000)).toBe('2 messages');
  expect(GATE_WORDS.settled).toBe('settled');
  setLanguagePref('da');
  expect(messagesWorth(1000, 1000)).toBe('1 besked');
  expect(GATE_WORDS.settled).toBe('betalt');
  expect(messagesWorth(2000, 1000)).toBe('2 beskeder');
  expect(freshnessText({ state: 'fresh', ageMs: 5000, clockSkew: false })).toBe('Opdateret for 5 s siden.');
  expect(connectionSummary({ remote: false, link: null, live: false, answer: null, stun: 'checking', lastCall: null }).join('\n')).toContain('kontrollerer…');
  vi.stubGlobal('__TAURI_INTERNALS__', {});
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Android');
  expect(endpointBadge(OWN_RULES).where).toBe('På denne telefon · regler');
  vi.unstubAllGlobals();
});

it('keeps sample history IDs stable across reads and a language switch', async () => {
  const source = sampleSource({ firstLiveMs: 1e9 });
  const track = SAMPLE_PEERS[0].node_id;
  setLanguagePref('en');
  const first = await source.messages(track);
  setLanguagePref('da');
  const second = await source.messages(track);
  expect(second.map(m => m.id)).toEqual(first.map(m => m.id));
  expect(second[0].plaintext).toContain('Godmorgen');
});

it('translates local failures while preserving raw node text and amount bytes', async () => {
  setLanguagePref('da');
  await expect(startRecording(() => {}, null)).rejects.toThrow('Dette vindue kan ikke optage lyd.');
  const raw = 'upstream_custom: node-provided English {0}';
  expect(softenError(raw).detail).toBe(raw);
  expect(groupDigits('1234567')).toBe('1\u202f234\u202f567');
  expect(groupDigits('1234567', true)).toBe('1\u2009234\u2009567');
  expect(amount(1250000)).toContain('1\u202f250');
});

it('keeps consent terms and native approval reason byte-identical in both languages', () => {
  const view = { client_pubkey: 'a'.repeat(64), request: { kind: 'spend_grant', terms: { budget_msat: 1250000, per_call_max_msat: 1000, window_secs: 600, recipient: undefined } } } as unknown as ApprovalView;
  setLanguagePref('en');
  const terms = termLines(view), reason = approvalReason(view);
  setLanguagePref('da');
  expect(termLines(view)).toEqual(terms);
  expect(approvalReason(view)).toBe(reason);
  expect(reason).toContain('1\u202f250 sats');
});
