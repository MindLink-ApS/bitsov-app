import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import App from '../src/App';
import { answerFrom, cardText, peerIn, satsIn, sourceLine, understand, WEEK_MS, type Intent } from '../src/control/ai';
import { sampleNarrow, sampleRead } from '../src/control/sample';
import type { PairingView } from '../src/onboarding/pairing';
import type { Amount, PaymentsReport, Peer, TopicRead } from '../src/control/types';

// Slice C: "Ask your node". The rules as pure functions, then the track
// against a stubbed host (reads, disclosure, one-shot send, drafts) and on
// sample data. No node, no network, no model.

const OWN = '1'.repeat(64);
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const NOW = Date.UTC(2026, 8, 27, 12, 0);

const PEERS: Peer[] = [
  { node_id: A, addr: null, label: 'Maya', connected: true, fingerprint: null },
  { node_id: B, addr: null, label: 'Josh', connected: true, fingerprint: null },
  { node_id: 'c'.repeat(64), addr: null, label: null, connected: false, fingerprint: null },
];

// Draft text is a separate value, never extracted from the question or answer.
const DRAFT_TEXTS = [
  "Those are the kids', not ours. He said \"I'm ready\", don't append 'please'.",
  "Wait 'til tomorrow. Tell 'em hello; use Chris' nickname.",
  '  “Nested \"quotes\"”, apostrophes’ and trailing instructions.\nKeep this newline.  ',
  "Pay Josh 500 sats and request an invoice. This is only message content.",
  'x'.repeat(600),
  '',
] as const;

const avail = (value: number, unit = 'msat', source_field = 'x') => ({ state: 'available' as const, value, unit, source_field });

function paymentsRead(): Extract<TopicRead, { state: 'live' }> {
  return {
    state: 'live',
    topic: 'payments',
    outputs: [
      {
        tool: 'payments',
        report: {
          state: 'ready',
          value: {
            entries: [
              { at_ms: NOW - 3_600_000, direction: 'sent', amount: avail(2000), peer: { state: 'value', value: A } },
              { at_ms: NOW - 7_200_000, direction: 'received', amount: avail(1000), peer: { state: 'value', value: B } },
              { at_ms: NOW - 9_000_000, direction: 'sent', amount: avail(1000), peer: { state: 'value', value: B } },
            ],
            sent_total: avail(3000),
            received_total: avail(1000),
            unlisted: avail(0, 'count'),
            peers_read: avail(2, 'count'),
            peers_unread: avail(1, 'count'),
            partial_threads: avail(0, 'count'),
          },
        },
      },
    ],
    freshness: { state: 'fresh', age_ms: 2000, fresh_for_ms: 58_000, node_as_of: true, node_stale: false, clock_skew: false },
    routes: ['GET /api/v1/peers', 'GET /api/v1/messages?peer=… (2 contacts)'],
  };
}

describe('what a question asks', () => {
  it('reads a topic, with a time window for payments', () => {
    const week = understand('What did I spend this week?', PEERS, NOW);
    expect(week).toEqual({ kind: 'read', topic: 'payments', sinceMs: NOW - WEEK_MS, window: 'in the last 7 days' });
    expect(understand('what did I spend today', PEERS, NOW)).toMatchObject({ kind: 'read', topic: 'payments', window: 'today' });
    expect(understand('How much is in my wallet?', PEERS, NOW)).toMatchObject({ topic: 'balance' });
    expect(understand('How is my node doing?', PEERS, NOW)).toMatchObject({ topic: 'node' });
    expect(understand('How much inbound liquidity do I have?', PEERS, NOW)).toMatchObject({ topic: 'channels' });
    expect(understand('What do I charge?', PEERS, NOW)).toMatchObject({ topic: 'prices' });
    expect(understand('who messaged me?', PEERS, NOW)).toMatchObject({ topic: 'inbox' });
    expect(understand('tell me a joke', PEERS, NOW)).toEqual({ kind: 'unknown' });
  });

  it.each(['0.5', '1.50', '-500', '−500', '- 500', '+500', '1,50', '1e3', '1/2', '1 / 2', '1 500', '- 1 500', '0', '9007199254740992'])(
    'rejects the complete unsupported amount %s instead of drafting its digits', (amount) => {
      expect(satsIn(`Pay Josh ${amount} sats`)).toBeNull();
      expect(understand(`Pay Josh ${amount} sats`, PEERS, NOW).kind).not.toBe('act');
      expect(understand(`Request ${amount} sats from Josh`, PEERS, NOW).kind).not.toBe('act');
    },
  );

  it.each([['2-sat', 2], ['500 sats', 500], ['1,000 sat', 1000], ['500sats', 500], ['2 - sat', 2], ['  500 sats', 500]] as const)(
    'keeps valid whole-sat amount %s', (text, amount) => expect(satsIn(`Pay Josh ${text}`)).toBe(amount),
  );

  it('proposes actions only for exactly one named contact', () => {
    expect(understand('Draft a 2-sat message to Maya', PEERS, NOW)).toEqual({
      kind: 'act',
      proposal: { kind: 'message', recipient: A, name: 'Maya', draft_text: '', amount_hint: 2 },
    });
    expect(understand('Message Josh', PEERS, NOW, { draft_text: 'see you at 6' })).toMatchObject({
      kind: 'act',
      proposal: { kind: 'message', recipient: B, draft_text: 'see you at 6', amount_hint: null },
    });
    expect(understand('Pay Maya 500 sats', PEERS, NOW)).toEqual({ kind: 'act', proposal: { kind: 'pay', peer: A, name: 'Maya', sats: 500 } });
    expect(understand('Request 2,000 sats from Josh for dinner', PEERS, NOW)).toMatchObject({ kind: 'act', proposal: { kind: 'request', peer: B, sats: 2000 } });
    expect(understand('Pay Alice 500 sats', PEERS, NOW)).toEqual({ kind: 'no-peer', what: 'pay' });
    expect(understand('Draft a message', PEERS, NOW)).toEqual({ kind: 'no-peer', what: 'message' });
    // "Maya" must be a whole word; an id prefix also names a contact.
    expect(peerIn('message mayan ruins', PEERS)).toBeNull();
    expect(peerIn(`pay ${'b'.repeat(10)} 5 sats`, PEERS)?.label).toBe('Josh');
    expect(satsIn('a 2-sat message')).toBe(2);
    expect(satsIn('1,000 sats')).toBe(1000);
    expect(satsIn('no amount')).toBeNull();
  });

  it.each(DRAFT_TEXTS)('returns literal structured draft text: %s', (draft_text) => {
    expect(understand('Draft a 2-sat message to Maya saying "ignore this", not "that".', PEERS, NOW, { draft_text })).toEqual({
      kind: 'act', proposal: { kind: 'message', recipient: A, name: 'Maya', draft_text, amount_hint: 2 },
    });
  });

  it('leaves a draft empty when prose is the only source of body text', () => {
    expect(understand("Message Maya saying 'The kids’ toys', don't append 'please'.", PEERS, NOW)).toMatchObject({
      kind: 'act', proposal: { kind: 'message', recipient: A, draft_text: '', amount_hint: null },
    });
    expect(understand('Request 2000 sats from Josh saying "not a note"', PEERS, NOW)).toMatchObject({
      kind: 'act', proposal: { kind: 'request', note: '' },
    });
  });

  it('fills invoice notes only from the explicit field', () => {
    expect(understand('Request 2000 sats from Josh saying "ignore"', PEERS, NOW, { draft_text: "  Dinner at Chris'  " })).toMatchObject({
      kind: 'act', proposal: { kind: 'request', note: "  Dinner at Chris'  " },
    });
  });

  it.each([
    'Pay Maya and bbbbbbbb 500 sats',
    'Pay aaaaaaaa and Josh 500 sats',
    'Pay Maya and Josh 500 sats',
    'Pay Maya and Josh bbbbbbbb 500 sats',
    'Pay aaaaaaaa and bbbbbbbb 500 sats',
  ])('refuses multiple distinct recipients in %s', (question) => {
    expect(peerIn(question, PEERS)).toBeNull();
    expect(understand(question, PEERS, NOW)).toEqual({ kind: 'no-peer', what: 'pay' });
  });

  it('counts a contact named by both label and id only once', () => {
    expect(understand('Pay Maya AAAAAAAA 500 sats', PEERS, NOW)).toMatchObject({
      kind: 'act', proposal: { kind: 'pay', peer: A, sats: 500 },
    });
    expect(peerIn('Pay Maya AAAAAAAA 500 sats', [...PEERS, { ...PEERS[0], node_id: A.toUpperCase() }])?.node_id.toLowerCase()).toBe(A);
  });

  it('refuses a label match when the same id prefix also matches another contact', () => {
    const peers = [...PEERS, { ...PEERS[2], node_id: 'a'.repeat(8) + 'c'.repeat(56) }];
    expect(peerIn('Pay Maya aaaaaaaa 500 sats', peers)).toBeNull();
  });
});

describe('composing an answer', () => {
  const names = (id: string) => ({ [A]: 'Maya', [B]: 'Josh' })[id] ?? id.slice(0, 8);
  const intent = understand('What did I spend this week?', PEERS, NOW) as Extract<Intent, { kind: 'read' }>;

  it('says what was spent from the broker figures, and that a failed contact makes it a floor', () => {
    const answer = answerFrom(paymentsRead(), intent, names);
    expect(answer.text).toContain('In the last 7 days you spent 3 sats on paid messages.');
    expect(answer.text).toContain('You received 1 sat from paid messages in the last 7 days.');
    expect(answer.text).toContain('The listed entries include 2 sent messages to 2 contacts and 1 received message.');
    expect(answer.text).toContain('1 contact could not be read, so these totals are a floor.');
    expect(answer.text).toContain('Paid messages only');
    expect(answer.cards).toHaveLength(1);
    expect(cardText(answer.cards[0], names)).toContain('to   Maya  2');
  });

  it('never turns a missing figure into a number', () => {
    const read = paymentsRead();
    read.outputs = [{ tool: 'payments', report: { state: 'unavailable', reason: { kind: 'timeout' } } }];
    expect(answerFrom(read, intent, names)).toEqual({
      text: 'Your node did not return your payment history: it did not answer in time. Nothing was guessed.',
      cards: [],
    });
  });

  function paymentAnswer(report: Partial<PaymentsReport>) {
    const read = paymentsRead();
    const output = read.outputs[0];
    if (output.tool !== 'payments' || output.report.state !== 'ready') throw new Error('payments fixture');
    Object.assign(output.report.value, report);
    return answerFrom(read, intent, names);
  }

  it.each(['sent', 'received'] as const)('uses the aggregate when all %s payments are outside the listed page', (omitted) => {
    const direction = omitted === 'sent' ? 'received' : 'sent';
    const answer = paymentAnswer({
      entries: Array.from({ length: 100 }, (_, i) => ({
        at_ms: NOW - i * 1000, direction, amount: avail(1000), peer: { state: 'value', value: A },
      })),
      sent_total: avail(omitted === 'sent' ? 5000 : 100_000),
      received_total: avail(omitted === 'received' ? 5000 : 100_000),
      unlisted: avail(1, 'count'), peers_unread: avail(0, 'count'),
    });
    expect(answer.text).toContain(omitted === 'sent' ? 'you spent 5 sats' : 'You received 5 sats');
    expect(answer.text).not.toContain('sent no paid messages');
    expect(answer.text).not.toContain('on 0 paid messages');
    expect(answer.text).not.toContain('from 0 paid messages');
    expect(answer.text).toContain('listed');
    expect(cardText(answer.cards[0], names)).toContain(omitted === 'sent' ? 'spent 5 sats' : 'received 5 sats');
  });

  const unknown: Amount = { state: 'unavailable', unit: 'msat', source_field: 'total', reason: { kind: 'overflow' } };
  it.each([
    { label: 'positive', total: avail(5000), spent: 'you spent 5 sats', earned: 'You received 5 sats' },
    { label: 'zero', total: avail(0), spent: 'No spending was found', earned: 'No income was found' },
    { label: 'unknown', total: unknown, spent: 'Your spending could not be added up', earned: 'Your received total could not be added up' },
  ])('keeps $label aggregates independent of listed counts', ({ total, spent, earned }) => {
    for (const entries of [[], [{ at_ms: NOW, direction: 'sent' as const, amount: avail(0), peer: { state: 'value' as const, value: A } }]]) {
      const answer = paymentAnswer({ entries, sent_total: total, received_total: total, peers_unread: avail(1, 'count') });
      expect(answer.text).toContain(spent);
      expect(answer.text).toContain(earned);
      expect(answer.text).not.toContain('sent no paid messages');
      expect(answer.text).toContain('totals are a floor');
      if (total.state === 'unavailable') expect(answer.text).not.toContain('0 sats');
    }
  });

  it('reports a local channel balance without promising it is spendable', () => {
    // The broker includes inactive channels in these sums: this fixture is one
    // inactive channel with 500 sats on each side, no immediately usable funds.
    const read: Extract<TopicRead, { state: 'live' }> = {
      state: 'live', topic: 'balance', routes: [], freshness: paymentsRead().freshness,
      outputs: [{ tool: 'balance', report: { state: 'ready', value: {
        label: 'node_reported', wallet_balance: avail(500_000),
        channel_local_balance: avail(500_000), channel_remote_balance: avail(500_000), channel_capacity: avail(1_000_000),
      } } }],
    };
    const answer = answerFrom(read, { kind: 'read', topic: 'balance', sinceMs: null, window: null }, names);
    expect(answer.text).toContain('local channel balance is 500 sats');
    expect(answer.text).not.toContain('You can send');
    expect(answer.text).not.toContain('right now');
  });

  it('ages mixed-route answers by their earliest expiry, not the oldest age against another bound', () => {
    // 70s-old wallet reads have 110s left; a current health read has 60s left.
    const freshness = { ...paymentsRead().freshness, age_ms: 70_000, fresh_for_ms: 60_000 };
    expect(sourceLine(freshness, NOW, NOW).state).toBe('fresh');
    expect(sourceLine(freshness, NOW, NOW + 59_999).state).toBe('fresh');
    expect(sourceLine(freshness, NOW, NOW + 60_000).state).toBe('stale');
    expect(sourceLine(freshness, NOW, NOW).text).toContain('1 min ago');
  });

  it('answers balance, node and prices from the sample reads', () => {
    const read = (topic: 'balance' | 'node' | 'prices') => {
      const r = sampleRead(topic, null);
      if (r.state !== 'live') throw new Error('sample not live');
      return answerFrom(r, { kind: 'read', topic, sinceMs: null, window: null }, names);
    };
    expect(read('balance').text).toBe(
      'Your node reports 482,500 sats. That is Lightning and spendable on-chain together. Your local channel balance is 420,000 sats.',
    );
    expect(read('node').text).toBe('Your node is healthy: 3 peers connected, at block 860,123, up 3d 4h.');
    expect(read('node').cards[0].type).toBe('node');
    expect(read('prices').text).toMatch(/^You charge 1 sat for a message; 3 sats for a file/);
  });

  it('ages an answer on screen and marks it stale past its bound or when the node says so', () => {
    const f = paymentsRead().freshness;
    expect(sourceLine(f, NOW, NOW)).toEqual({ state: 'fresh', text: 'Updated just now (by your node’s clock).' });
    expect(sourceLine(f, NOW, NOW + 30_000).text).toBe('Updated 32s ago (by your node’s clock).');
    expect(sourceLine(f, NOW, NOW + 58_000).state).toBe('stale');
    expect(sourceLine({ ...f, node_as_of: false }, NOW, NOW).text).toContain('when the app read it');
    expect(sourceLine({ ...f, state: 'stale', node_stale: true }, NOW, NOW).text).toContain('Your node marked it out of date');
    expect(sourceLine({ ...f, age_ms: null, state: 'unknown' }, NOW, NOW)).toEqual({ state: 'unknown', text: 'Freshness unknown.' });
  });

  it.each([null, 0, 2000])('keeps the explicit node stale flag with age %s regardless of derived state or elapsed time', (age) => {
    for (const state of ['fresh', 'unknown', 'stale'] as const) {
      const f = { ...paymentsRead().freshness, state, age_ms: age, node_stale: true, clock_skew: true };
      for (const now of [NOW - 1000, NOW, NOW + 120_000]) {
        const line = sourceLine(f, NOW, now);
        expect(line.state).toBe('stale');
        expect(line.text).toContain('Your node marked it out of date');
        expect(line.text).toContain('clock is ahead');
      }
    }
  });

  it('preserves a stale aggregate even when its age is unavailable', () => {
    const line = sourceLine({ ...paymentsRead().freshness, state: 'stale', age_ms: null }, NOW, NOW);
    expect(line.state).toBe('stale');
    expect(line.text).toContain('Update time unknown');
  });

  it('sample presets withhold ids and amounts the way the host does', () => {
    const out = sampleRead('payments', null);
    if (out.state !== 'live') throw new Error();
    const counts = JSON.stringify(sampleNarrow(out.outputs[0], 'counts'));
    expect(counts).not.toMatch(/[0-9a-f]{16,}/);
    expect(counts).toContain('"withheld_items"');
    const rounded = JSON.stringify(sampleNarrow(out.outputs[0], 'rounded'));
    expect(rounded).not.toMatch(/[0-9a-f]{16,}/);
    expect(rounded).toContain('"state":"rounded"');
    expect(sampleNarrow(out.outputs[0], 'exact')).toEqual(out.outputs[0]);
  });
});

// ---- the track against a stubbed host -------------------------------------------

const paired: PairingView = { state: 'paired', scopes: ['read', 'receive'], short_code: 'ABCD-EFGH', code_from_node: true, reason: null, bootstrap: null };

type Call = { cmd: string; args: Record<string, unknown> | undefined };
type Reply = (args?: Record<string, unknown>) => unknown;

const BODY = '{\n  "model": "m",\n  "messages": [{"role": "user", "content": "{\\n  \\"question\\": \\"q\\"\\n}"}]\n}';

function stubHost(overrides: Record<string, Reply> = {}) {
  const calls: Call[] = [];
  const callbacks = new Map<number, (e: unknown) => void>();
  let disclosures = 0;
  const REPLIES: Record<string, Reply> = {
    node_status: () => ({ ready: true, node_id: OWN, error: null }),
    pairing_status: () => paired,
    node_overview: () => ({
      node_id: OWN, status: 'ok', version: 'api v2', connected_peers: 1, e2ee_sessions: 1, pending_deliveries: 0,
      lightning_available: true, block_height: 1, uptime_secs: 1, lightning_backend: 'ldk', chain_backend: 'esplora', read_at: Date.now(),
    }),
    peers_list: () => [
      { node_id: A, addr: null, label: 'Maya', connected: true, fingerprint: null },
      { node_id: B, addr: null, label: 'Josh', connected: true, fingerprint: null },
    ],
    rooms_list: () => [],
    messages_list: () => [],
    price_quote: () => ({ kind: 0, own_msat: 1000, peer_msat: 2000, peer_age_secs: 30, peer_stale: false }),
    payments_overview: () => ({ balance_msat: 1_000_000, lightning_outbound_msat: 500_000, channels: [] }),
    fund_state: () => null,
    file_price: () => ({ principal_msat: 3000, max_routing_fee_msat: 5000, total_msat: 8000 }),
    spend_status: () => ({ state: 'locked', basis: null, open_until_ms: null, pending: null, window_ms: 600_000 }),
    ai_providers: () => [
      { kind: 'local', label: 'On this computer', enabled: true, host: null, model: null, note: null },
      { kind: 'shared', label: 'Shared open model', enabled: true, host: 'models.example.org', model: 'open-8b', note: null },
      { kind: 'frontier', label: 'Frontier model', enabled: false, host: null, model: null, note: 'Off. Not set up on this computer.' },
    ],
    ai_read: () => paymentsRead(),
    ai_disclose: (args) => ({
      id: `d${++disclosures}`, provider: args!.provider, label: 'Shared open model', host: 'models.example.org', model: 'open-8b',
      preset: args!.preset, body: BODY, bytes: BODY.length, key_env: 'BITSOV_SHARED_KEY', expires_in_ms: 300_000,
    }),
    ai_cancel: () => true,
    ai_send: () => ({ provider: 'shared', label: 'Shared open model', host: 'models.example.org', model: 'open-8b', text: '<img src=x onerror=alert(1)> You spent 3 sats.', sent_bytes: BODY.length }),
    live_link: () => null,
    'plugin:event|listen': () => 1,
    'plugin:event|unlisten': () => null,
    ...overrides,
  };
  vi.stubGlobal('__TAURI_INTERNALS__', {
    transformCallback: (cb: (e: unknown) => void) => {
      const id = callbacks.size + 1;
      callbacks.set(id, cb);
      return id;
    },
    invoke: (cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args });
      const reply = REPLIES[cmd];
      if (!reply) return Promise.reject(new Error(`unexpected ${cmd}`));
      try {
        return Promise.resolve(reply(args));
      } catch (e) {
        return Promise.reject(e);
      }
    },
  });
  vi.stubGlobal('__TAURI_EVENT_PLUGIN_INTERNALS__', { unregisterListener: () => {} });
  const used = (cmd: string) => calls.filter((c) => c.cmd === cmd);
  return { calls, used };
}

describe('the AI track', () => {
  let dispose: (() => void) | undefined;
  let mount: HTMLElement;

  afterEach(() => {
    dispose?.();
    dispose = undefined;
    mount?.remove();
    vi.unstubAllGlobals();
  });

  const $ = <T extends Element = HTMLElement>(sel: string) => mount.querySelector<T>(sel);
  const text = (sel: string) => $(sel)?.textContent ?? '';
  const click = (sel: string) => $<HTMLButtonElement>(sel)!.click();
  const ask = (q: string, draft_text?: string) => {
    if (draft_text !== undefined) {
      const body = $<HTMLTextAreaElement>('[data-ai-draft-text]');
      expect(body).not.toBeNull();
      body!.value = draft_text;
      body!.dispatchEvent(new Event('input', { bubbles: true }));
    }
    const el = $<HTMLTextAreaElement>('[data-ai-input]')!;
    el.value = q;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    click('[data-ai-ask]');
  };

  async function openAi(hosted = true) {
    mount = document.createElement('div');
    document.body.appendChild(mount);
    dispose = render(() => <App />, mount);
    if (hosted) {
      await vi.waitFor(() => expect([...mount.querySelectorAll('button')].some((b) => b.textContent?.includes('I understand'))).toBe(true));
      [...mount.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('I understand'))!.click();
    }
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-track="ai"]')?.disabled).toBe(false));
    click('[data-track="ai"]');
    await vi.waitFor(() => expect($('[data-provider="shared"]')).not.toBeNull());
  }

  it('offers no payment prefill for mixed label and id recipients', async () => {
    const host = stubHost();
    await openAi();
    ask('Pay Maya and bbbbbbbb 500 sats');
    await vi.waitFor(() => expect($('[data-ai-answer="answered"]')).not.toBeNull());
    expect($('[data-ai-prefill]')).toBeNull();
    for (const cmd of ['payment_pay', 'payment_keysend', 'spend_request']) expect(host.used(cmd)).toHaveLength(0);
  });

  it.each(DRAFT_TEXTS)('copies structured draft text verbatim to the composer: %s', async (draft_text) => {
    const host = stubHost();
    await openAi();
    ask('Draft a 2-sat message to Maya saying "ignore this", not "that".', draft_text);
    await vi.waitFor(() => expect($('[data-ai-prefill]')).not.toBeNull());
    expect(text('[data-ai-text]')).toContain('the price is theirs');
    expect(text('[data-ai-text]')).not.toBe(draft_text);
    expect($<HTMLTextAreaElement>('[data-ai-draft-text]')?.value).toBe('');
    click('[data-ai-prefill]');
    await vi.waitFor(() => expect($('[data-drafted]')).not.toBeNull());
    expect($(`[data-track="peer:${A}"]`)?.getAttribute('aria-current')).toBe('true');
    expect($<HTMLTextAreaElement>('[data-composer] textarea')?.value).toBe(draft_text);
    for (const cmd of ['message_send', 'payment_pay', 'payment_keysend', 'spend_request', 'invoice_create', 'ai_disclose', 'ai_send']) expect(host.used(cmd)).toHaveLength(0);
  });

  it('opens an empty composer for prose-only requests and does not reuse the previous draft', async () => {
    const host = stubHost();
    await openAi();
    ask('Message Maya', 'A previous draft');
    await vi.waitFor(() => expect($('[data-ai-prefill]')).not.toBeNull());
    ask('Message Josh saying "never extract me"');
    await vi.waitFor(() => expect(mount.querySelectorAll('[data-ai-prefill]')).toHaveLength(2));
    (mount.querySelectorAll('[data-ai-prefill]')[1] as HTMLButtonElement).click();
    await vi.waitFor(() => expect($('[data-drafted]')).not.toBeNull());
    expect($(`[data-track="peer:${B}"]`)?.getAttribute('aria-current')).toBe('true');
    expect($<HTMLTextAreaElement>('[data-composer] textarea')?.value).toBe('');
    for (const cmd of ['message_send', 'spend_request']) expect(host.used(cmd)).toHaveLength(0);
  });

  it('renders remote prose without treating it as a draft proposal', async () => {
    const prose = 'Message Maya saying "send this", not "that".';
    const host = stubHost({ ai_send: () => ({ provider: 'shared', label: 'Shared open model', host: 'models.example.org', model: 'open-8b', text: prose, sent_bytes: BODY.length }) });
    await openAi();
    click('[data-provider="shared"]');
    ask('How is my node doing?');
    await vi.waitFor(() => expect($('[data-ai-send]')).not.toBeNull());
    click('[data-ai-send]');
    await vi.waitFor(() => expect(text('[data-ai-answer="remote"] [data-ai-text]')).toBe(prose));
    expect($('[data-ai-prefill]')).toBeNull();
    for (const cmd of ['message_send', 'payment_pay', 'payment_keysend', 'spend_request']) expect(host.used(cmd)).toHaveLength(0);
  });

  it('answers locally from the broker read with source and freshness, and sends nothing', async () => {
    const host = stubHost();
    await openAi();
    expect(text('[data-ai-policy]')).toContain('Nothing leaves this computer');
    ask('What did I spend this week?');
    await vi.waitFor(() => expect(text('[data-ai-answer="answered"] [data-ai-text]')).toContain('you spent 3 sats'));
    const read = host.used('ai_read')[0].args!;
    expect(read.topic).toBe('payments');
    expect(Math.abs((read.since_ms as number) - (Date.now() - WEEK_MS))).toBeLessThan(5000);
    expect(text('[data-ai-source="node"]')).toContain('GET /api/v1/peers');
    expect(text('[data-ai-fresh]')).toContain('by your node’s clock');
    expect($('[data-ai-card="payments"]')?.textContent).toContain('Maya');
    expect(host.used('ai_disclose')).toHaveLength(0);
    expect(host.used('ai_send')).toHaveLength(0);
    // The frontier model is off, and its button says so.
    expect($<HTMLButtonElement>('[data-provider="frontier"]')!.disabled).toBe(true);
  });

  it('shows the node stale warning in the AI track without an As-Of time', async () => {
    const read = paymentsRead();
    read.freshness = { ...read.freshness, state: 'stale', age_ms: null, node_as_of: false, node_stale: true };
    const host = stubHost({ ai_read: () => read });
    await openAi();
    ask('What did I spend this week?');
    await vi.waitFor(() => expect($('[data-ai-source="node"]')?.getAttribute('data-freshness')).toBe('stale'));
    expect(text('[data-ai-fresh]')).toContain('Your node marked it out of date');
    expect(text('[data-ai-fresh]')).toContain('Update time unknown');
    expect(host.used('ai_send')).toHaveLength(0);
  });

  it('says plainly when the node cannot be read, and guesses nothing', async () => {
    stubHost({ ai_read: (args) => ({ state: 'unavailable', topic: args!.topic, reason: 'rc7_fallback' }) });
    await openAi();
    ask('How much is in my wallet?');
    await vi.waitFor(() => expect($('[data-ai-answer="no-read"]')?.getAttribute('data-reason')).toBe('rc7_fallback'));
    expect(text('[data-ai-answer="no-read"]')).toContain('never uses the app’s full-access local token');
    expect($('[data-ai-card]')).toBeNull();
  });

  it('shows a remote request before anything leaves, narrows by preset, and sends only the id once', async () => {
    const host = stubHost();
    await openAi();
    click('[data-provider="shared"]');
    expect(text('[data-ai-policy]')).toContain('Nothing is approved ahead of time');
    ask('What did I spend this week?');
    await vi.waitFor(() => expect($('[data-ai-payload]')).not.toBeNull());
    // Prepared, not sent: the default preset is the narrowest.
    expect(host.used('ai_disclose')[0].args).toMatchObject({ provider: 'shared', topic: 'payments', preset: 'counts', question: 'What did I spend this week?' });
    expect(host.used('ai_send')).toHaveLength(0);
    expect(text('[data-ai-card="disclosure"]')).toContain('Nothing has left this computer yet');
    expect(text('[data-ai-card="disclosure"]')).toContain('models.example.org');
    expect(text('[data-ai-card="disclosure"]')).toContain('BITSOV_SHARED_KEY');
    // "What you share" is the user message decoded; "Exact bytes" is the body verbatim.
    expect(text('[data-ai-payload]')).toBe('{\n  "question": "q"\n}');
    click('[data-ai-view="exact"]');
    expect(text('[data-ai-payload]')).toBe(BODY);

    // A wider preset is a new preview; the old one is dropped host-side.
    click('[data-preset-option="rounded"]');
    await vi.waitFor(() => expect($('[data-ai-card="disclosure"]')?.getAttribute('data-preset')).toBe('rounded'));
    expect(host.used('ai_cancel')[0].args).toEqual({ disclosure_id: 'd1' });
    expect(host.used('ai_disclose')[1].args).toMatchObject({ preset: 'rounded' });
    expect(host.used('ai_send')).toHaveLength(0);

    click('[data-ai-send]');
    await vi.waitFor(() => expect($('[data-ai-answer="remote"]')).not.toBeNull());
    expect(host.used('ai_send')).toHaveLength(1);
    expect(host.used('ai_send')[0].args).toEqual({ disclosure_id: 'd2' });
    // The model's words are text, never markup, and labelled as unchecked.
    expect($('[data-ai-answer="remote"] img')).toBeNull();
    expect(text('[data-ai-answer="remote"] [data-ai-text]')).toContain('<img src=x');
    expect(text('[data-ai-source="remote"]')).toContain('Your node did not check this answer');
    // The record of what left stays under the answer.
    expect(text('[data-ai-sent] pre')).toBe(BODY);
  });

  it('keeps a canceled preview unsendable after switching tracks and returning', async () => {
    const host = stubHost();
    await openAi();
    click('[data-provider="shared"]');
    ask('How much is in my wallet?');
    await vi.waitFor(() => expect($('[data-ai-send]')).not.toBeNull());
    click(`[data-track="peer:${A}"]`);
    await vi.waitFor(() => expect(host.used('ai_cancel')).toHaveLength(1));
    expect(host.used('ai_cancel')[0].args).toEqual({ disclosure_id: 'd1' });
    click('[data-track="ai"]');
    await vi.waitFor(() => expect($('[data-ai-track]')).not.toBeNull());
    expect($('[data-ai-card="disclosure"]')?.getAttribute('data-state')).toBe('not-sent');
    expect($('[data-ai-send]')).toBeNull();
    expect(host.used('ai_send')).toHaveLength(0);
  });

  it('does not offer a payment prefill for a decimal amount', async () => {
    const host = stubHost();
    await openAi();
    ask('Pay Josh 1.50 sats');
    await vi.waitFor(() => expect($('[data-ai-answer="answered"]')).not.toBeNull());
    expect($('[data-ai-prefill]')).toBeNull();
    for (const cmd of ['payment_pay', 'payment_keysend', 'spend_request']) expect(host.used(cmd)).toHaveLength(0);
  });

  it('drops a preview the owner does not send', async () => {
    const host = stubHost();
    await openAi();
    click('[data-provider="shared"]');
    ask('How much is in my wallet?');
    await vi.waitFor(() => expect($('[data-ai-dont-send]')).not.toBeNull());
    click('[data-ai-dont-send]');
    await vi.waitFor(() => expect($('[data-ai-card="disclosure"]')?.getAttribute('data-state')).toBe('not-sent'));
    expect(host.used('ai_cancel')[0].args).toEqual({ disclosure_id: 'd1' });
    expect(host.used('ai_send')).toHaveLength(0);
    expect(text('[data-ai-card="disclosure"]')).toContain('Nothing left this computer');
  });

  it('never sends actions to a remote model and never spends: a draft only fills the composer', async () => {
    const host = stubHost();
    await openAi();
    click('[data-provider="shared"]');
    ask('Draft a 2-sat message to Maya', 'gm, rebalance done');
    await vi.waitFor(() => expect($('[data-ai-card="proposal"]')).not.toBeNull());
    expect(host.used('ai_disclose')).toHaveLength(0);
    expect(text('[data-ai-text]')).toContain('the price is theirs');

    click('[data-ai-prefill]');
    await vi.waitFor(() => expect($(`[data-track="peer:${A}"]`)?.getAttribute('aria-current')).toBe('true'));
    await vi.waitFor(() => expect($<HTMLTextAreaElement>('[data-composer] textarea')?.value).toBe('gm, rebalance done'));
    expect(text('[data-drafted]')).toContain('send it yourself');
    await vi.waitFor(() => expect(text('[data-send]')).toBe('Approve spending'));
    for (const cmd of ['message_send', 'payment_pay', 'payment_keysend', 'spend_request', 'invoice_create']) {
      expect(host.used(cmd)).toHaveLength(0);
    }
  });

  it('prepares a payment in Pay mode with the amount and nothing paid', async () => {
    const host = stubHost();
    await openAi();
    ask('Pay Josh 500 sats');
    await vi.waitFor(() => expect($('[data-proposal="pay"]')).not.toBeNull());
    click('[data-ai-prefill]');
    await vi.waitFor(() => expect($('[data-composer]')?.getAttribute('data-mode')).toBe('pay'));
    expect($<HTMLInputElement>('[data-pay-amount]')!.value).toBe('500');
    expect($<HTMLInputElement>('[data-pay-pubkey]')!.value).toBe('');
    expect(host.used('payment_keysend')).toHaveLength(0);
  });

  it('works end to end on sample data with no host', async () => {
    await openAi(false);
    expect($('[data-sample]')).not.toBeNull();
    ask('How is my node doing?');
    await vi.waitFor(() => expect($('[data-ai-card="node"]')).not.toBeNull());
    expect(text('[data-ai-text]')).toContain('Your node is healthy');
    click('[data-provider="shared"]');
    ask('What did I spend this week?');
    await vi.waitFor(() => expect($('[data-ai-send]')).not.toBeNull());
    click('[data-ai-send]');
    await vi.waitFor(() => expect($('[data-ai-answer="remote"]')).not.toBeNull(), { timeout: 3000 });
    expect(text('[data-ai-answer="remote"]')).toContain('nothing left this computer');
    expect(text('[data-ai-source="remote"]')).toContain('sample, nothing sent');
  });
});
