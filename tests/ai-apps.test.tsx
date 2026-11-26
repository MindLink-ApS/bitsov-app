import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { readFileSync } from 'node:fs';
import { AiApps } from '../src/control/AiApps';
import {
  auditWhat, errorCopy, MCP_ERROR_CODES, MCP_MAX_CLIENTS, type AiAppsApi, type McpAuditPage, type McpClient, type McpPending, type McpStatus,
} from '../src/control/aiAppsApi';
import { appDa, appEn } from '../src/appCopy';
import { setLanguagePref } from '../src/i18n';

let dispose: (() => void) | undefined;
let mount: HTMLElement;
afterEach(() => { dispose?.(); mount?.remove(); setLanguagePref('en'); });

const $ = <T extends HTMLElement = HTMLElement>(s: string) => mount.querySelector<T>(s);
const $$ = (s: string) => [...mount.querySelectorAll<HTMLElement>(s)];
const text = () => mount.textContent ?? '';

const OFF: McpStatus = { platform: 'ok', enabled: false, store: 'empty', start_error: null, pairing_open_s: null, waiting: 0, clients: 0, unsaved_revoke: false };
const WORDS = ['amber', 'river', 'lantern', 'violet', 'harbor', 'meadow'];
const REQUEST: McpPending = { id: 'mcp-0011223344556677', name: 'Desk helper', words: WORDS, expires_in_s: 110, others_refused: 0 };
const CLIENT: McpClient = { id: 'mcp-aa', name: 'Desk helper', topics: ['node', 'inbox'], preset: 'counts', created_ms: Date.UTC(2026, 10, 24) };

/** A fake host: state the test sets, calls the screen makes. */
function host(start: Partial<McpStatus> = {}, extra: { pending?: McpPending[]; clients?: McpClient[] } = {}) {
  const state = { status: { ...OFF, ...start }, pending: extra.pending ?? [], clients: extra.clients ?? [] };
  const listeners: (() => void)[] = [];
  const api = {
    status: vi.fn(async () => state.status),
    setEnabled: vi.fn(async (on: boolean) => { state.status = { ...state.status, enabled: on }; return state.status; }),
    openPairing: vi.fn(async () => { state.status = { ...state.status, pairing_open_s: 120 }; return state.status; }),
    closePairing: vi.fn(async () => { state.status = { ...state.status, pairing_open_s: null, waiting: 0 }; state.pending = []; return state.status; }),
    pending: vi.fn(async () => state.pending),
    approve: vi.fn(async (id: string, topics: McpClient['topics'], preset: McpClient['preset']) => {
      const client = { id, name: REQUEST.name, topics, preset, created_ms: 1 };
      state.clients = [...state.clients, client];
      state.pending = [];
      state.status = { ...state.status, pairing_open_s: null, waiting: 0, clients: state.clients.length, store: 'ok' };
      return client;
    }),
    deny: vi.fn(async () => { state.pending = []; state.status = { ...state.status, pairing_open_s: null, waiting: 0 }; return true; }),
    clients: vi.fn(async () => state.clients),
    revoke: vi.fn(async (id: string) => { state.clients = state.clients.filter(c => c.id !== id); return { saved: true }; }),
    saveAgain: vi.fn(async () => { state.status = { ...state.status, unsaved_revoke: false, start_error: null }; return { saved: true }; }),
    stopAll: vi.fn(async () => { state.status = { ...state.status, enabled: false, pairing_open_s: null }; return state.status; }),
    audit: vi.fn(async (): Promise<McpAuditPage> => ({ rows: [], unreadable: 0 })),
    resetClients: vi.fn(async () => { state.status = { ...state.status, store: 'empty' }; return state.status; }),
    onChanged: vi.fn((changed: () => void) => { listeners.push(changed); return () => { listeners.splice(listeners.indexOf(changed), 1); }; }),
  } satisfies AiAppsApi;
  /** The host's `mcp-changed` event. */
  const fire = () => { for (const changed of [...listeners]) changed(); };
  return { api, state, fire };
}

async function show(api: AiAppsApi) {
  mount = document.createElement('div');
  document.body.appendChild(mount);
  dispose = render(() => <AiApps api={api} />, mount);
  await vi.waitFor(() => expect($('[data-ai-ready]')).not.toBeNull());
}
const click = (s: string) => $<HTMLButtonElement>(s)!.click();
const toggle = (s: string) => $<HTMLInputElement>(s)!.click();

describe('Settings → AI apps', () => {
  it('starts off: the switch is off, no Add button, no request; the hint promises nothing it cannot keep', async () => {
    const { api } = host();
    await show(api);
    expect($<HTMLInputElement>('[data-ai-switch]')!.checked).toBe(false);
    expect($('[data-ai-switch]')!.getAttribute('role')).toBe('switch');
    expect($('[data-ai-add]')).toBeNull();
    expect($('[data-ai-request]')).toBeNull();
    expect($('[data-ai-switch-hint]')!.textContent).toBe(appEn.mcpSwitchHint);
    expect($('[data-ai-no-clients]')).not.toBeNull();
    expect(api.setEnabled).not.toHaveBeenCalled();
  });

  it('turning it on asks the host, then offers “Add an AI app” and a stop for all', async () => {
    const { api } = host();
    await show(api);
    toggle('[data-ai-switch]');
    await vi.waitFor(() => expect($('[data-ai-add]')).not.toBeNull());
    expect(api.setEnabled).toHaveBeenCalledWith(true);
    expect($<HTMLInputElement>('[data-ai-switch]')!.checked).toBe(true);
    expect($('[data-ai-howto]')!.textContent).toBe(appEn.mcpHowTo);
    expect($('[data-ai-stop-all]')).not.toBeNull();
    // The setup step is behind a closed Details, for whoever sets up the AI app.
    expect(($('[data-ai-setup]') as HTMLDetailsElement).open).toBe(false);
  });

  it('“Add an AI app” opens a two-minute window the owner can stop', async () => {
    const { api } = host({ enabled: true });
    await show(api);
    click('[data-ai-add]');
    await vi.waitFor(() => expect($('[data-ai-window]')).not.toBeNull());
    expect(api.openPairing).toHaveBeenCalledOnce();
    expect($('[data-ai-window]')!.textContent).toBe('Waiting for your AI app: 2:00 left. An app can only ask while this is open.');
    expect($('[data-ai-add]')).toBeNull();
    click('[data-ai-window-cancel]');
    await vi.waitFor(() => expect($('[data-ai-window]')).toBeNull());
    expect(api.closePairing).toHaveBeenCalledOnce();
    expect($('[data-ai-add]')).not.toBeNull();
  });

  it('a waiting request shows the name, the six words large, and the warning before Approve', async () => {
    const { api } = host({ enabled: true, pairing_open_s: 100, waiting: 1 }, { pending: [REQUEST] });
    await show(api);
    await vi.waitFor(() => expect($('[data-ai-request]')).not.toBeNull());
    expect($('[data-ai-request] h3')!.textContent).toBe('Let “Desk helper” read from BitSov?');
    expect($$('[data-ai-words] li').map(li => li.textContent)).toEqual(WORDS);
    expect($('[data-ai-words]')!.tagName).toBe('OL');
    expect($('[data-ai-words-check]')!.textContent).toContain('in its chat');
    expect($('[data-ai-name-note]')!.textContent).toBe(appEn.mcpNameNote);
    expect($('[data-ai-expires]')!.textContent).toBe('Expires in 1:50 unless you approve it.');
    const warning = $('[data-ai-warning]')!;
    expect(warning.getAttribute('role')).toBe('note');
    expect(warning.querySelector('p')!.textContent).toBe(appEn.mcpHonest);
    expect(appEn.mcpHonest.startsWith('What this AI app reads can leave this computer, including to the company behind the AI.')).toBe(true);
    expect(appEn.mcpHonest).toContain('never your balance or payments');
    // The ADR sentence stays, word for word, under More detail.
    expect($('[data-ai-warning-more]')!.textContent).toContain(appEn.mcpHonestAdr);
    expect(($('[data-ai-warning-more]') as HTMLDetailsElement).open).toBe(false);
    expect(warning.compareDocumentPosition($('[data-ai-approve]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect($('[data-ai-others]')).toBeNull();
  });

  it('offers only node status, prices, connections and message counts (never balance or payments), counts only, and approve sends exactly that', async () => {
    const { api } = host({ enabled: true, pairing_open_s: 100, waiting: 1 }, { pending: [REQUEST] });
    await show(api);
    await vi.waitFor(() => expect($('[data-ai-request]')).not.toBeNull());
    expect($<HTMLButtonElement>('[data-ai-approve]')!.disabled).toBe(true);
    expect($('[data-ai-pick-one]')).not.toBeNull();
    expect($$('[data-ai-topic]').every(el => !(el as HTMLInputElement).checked)).toBe(true);
    expect($$('[data-ai-topic]').map(el => el.getAttribute('data-ai-topic'))).toEqual(['node', 'prices', 'channels', 'inbox']);
    for (const money of ['balance', 'payments']) expect($(`[data-ai-topic="${money}"]`)).toBeNull();
    // Connections stay, and say plainly that peers come under a code name, with no amounts.
    expect($('[data-ai-topic="channels"]')!.closest('label')!.textContent).toContain('Connections to other nodes');
    expect($('[data-ai-topic-hint="channels"]')!.textContent!.trim()).toBe('Who you’re connected to (under a code name), never how much.');
    // No choice of detail at all: one plain line says what it sees.
    expect($$('[data-ai-request] input[type="radio"]')).toHaveLength(0);
    expect($('[data-ai-preset]')).toBeNull();
    expect($('[data-ai-counts-only]')!.textContent).toBe(appEn.mcpCountsOnly);
    expect($('[data-ai-request]')!.textContent).not.toMatch(/Balance|Payments|Rounded/);
    toggle('[data-ai-topic="inbox"]');
    toggle('[data-ai-topic="channels"]');
    toggle('[data-ai-topic="node"]');
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-ai-approve]')!.disabled).toBe(false));
    click('[data-ai-approve]');
    await vi.waitFor(() => expect($('[data-ai-note="ok"]')).not.toBeNull());
    expect(api.approve).toHaveBeenCalledWith(REQUEST.id, ['node', 'channels', 'inbox'], 'counts');
    expect($('[data-ai-note="ok"]')!.textContent).toBe(appEn.mcpApproved);
    expect($('[data-ai-request]')).toBeNull();
    expect($$('[data-ai-client]')).toHaveLength(1);
  });

  it('a topic the host refuses is said plainly, and nothing is approved', async () => {
    const { api } = host({ enabled: true, pairing_open_s: 100, waiting: 1 }, { pending: [REQUEST] });
    api.approve.mockRejectedValueOnce('topic_not_allowed');
    await show(api);
    await vi.waitFor(() => expect($('[data-ai-request]')).not.toBeNull());
    toggle('[data-ai-topic="node"]');
    click('[data-ai-approve]');
    await vi.waitFor(() => expect($('[data-ai-note="err"]')).not.toBeNull());
    expect($('[data-ai-note="err"]')!.textContent).toBe(appEn.mcpTopicNotAllowed);
    expect($('[data-ai-request]')).not.toBeNull();
    expect($$('[data-ai-client]')).toHaveLength(0);
  });

  it('approve that could not be saved says so, and the request stays', async () => {
    const { api } = host({ enabled: true, pairing_open_s: 100, waiting: 1 }, { pending: [REQUEST] });
    api.approve.mockRejectedValueOnce('not_saved');
    await show(api);
    await vi.waitFor(() => expect($('[data-ai-request]')).not.toBeNull());
    toggle('[data-ai-topic="node"]');
    click('[data-ai-approve]');
    await vi.waitFor(() => expect($('[data-ai-note="err"]')).not.toBeNull());
    expect($('[data-ai-note="err"]')!.textContent).toBe(appEn.mcpApproveNotSaved);
    expect($('[data-ai-request]')).not.toBeNull();
  });

  it('deny sends the id and closes the request', async () => {
    const { api } = host({ enabled: true, pairing_open_s: 100, waiting: 1 }, { pending: [REQUEST] });
    await show(api);
    await vi.waitFor(() => expect($('[data-ai-request]')).not.toBeNull());
    click('[data-ai-deny]');
    await vi.waitFor(() => expect($('[data-ai-request]')).toBeNull());
    expect(api.deny).toHaveBeenCalledWith(REQUEST.id);
    expect(api.approve).not.toHaveBeenCalled();
    expect($('[data-ai-note="ok"]')!.textContent).toBe(appEn.mcpDenied);
  });

  it('a second program asking in the same window is shown as a warning', async () => {
    const { api } = host({ enabled: true, pairing_open_s: 100, waiting: 1 }, { pending: [{ ...REQUEST, others_refused: 1 }] });
    await show(api);
    await vi.waitFor(() => expect($('[data-ai-others]')).not.toBeNull());
    expect($('[data-ai-others]')!.textContent).toBe(appEn.mcpOthersTried);
  });

  it('lists approved apps with topics and date', async () => {
    const { api } = host({ enabled: true, store: 'ok', clients: 1 }, { clients: [CLIENT] });
    await show(api);
    await vi.waitFor(() => expect($('[data-ai-client="mcp-aa"]')).not.toBeNull());
    const row = $('[data-ai-client="mcp-aa"]')!.textContent!;
    expect(row).toContain('Desk helper');
    expect(row).toContain('Node status, New messages (count only, never the text)');
    expect(row).toContain('Added');
  });

  it('remove asks first, says what the app keeps, and confirms a saved removal', async () => {
    const { api } = host({ enabled: true, store: 'ok', clients: 1 }, { clients: [CLIENT] });
    await show(api);
    await vi.waitFor(() => expect($('[data-ai-remove="mcp-aa"]')).not.toBeNull());
    click('[data-ai-remove="mcp-aa"]');
    expect(api.revoke).not.toHaveBeenCalled();
    expect($('[data-ai-remove-confirm]')!.textContent).toBe('Remove “Desk helper”? It can’t start any new reads. What it already read, it keeps.');
    click('[data-ai-remove-yes]');
    await vi.waitFor(() => expect($('[data-ai-note="ok"]')).not.toBeNull());
    expect(api.revoke).toHaveBeenCalledWith('mcp-aa');
    expect($('[data-ai-note="ok"]')!.textContent).toBe(appEn.mcpRevoked);
    expect($('[data-ai-client="mcp-aa"]')).toBeNull();
  });

  it('a removal that was not saved never says “nothing changed”: it says so and offers Save again', async () => {
    const { api, state } = host({ enabled: true, store: 'ok', clients: 1 }, { clients: [CLIENT] });
    api.revoke.mockImplementationOnce(async () => {
      state.clients = [];
      state.status = { ...state.status, enabled: false, unsaved_revoke: true, start_error: 'removal_not_saved' };
      return { saved: false };
    });
    await show(api);
    await vi.waitFor(() => expect($('[data-ai-remove="mcp-aa"]')).not.toBeNull());
    click('[data-ai-remove="mcp-aa"]');
    click('[data-ai-remove-yes]');
    await vi.waitFor(() => expect($('[data-ai-unsaved]')).not.toBeNull());
    expect($('[data-ai-unsaved]')!.textContent).toContain(appEn.mcpRevokeNotSaved);
    expect($('[data-ai-note="ok"]')).toBeNull();
    expect(text()).not.toMatch(/nothing changed/i);
    click('[data-ai-save-again]');
    await vi.waitFor(() => expect($('[data-ai-unsaved]')).toBeNull());
    expect(api.saveAgain).toHaveBeenCalledOnce();
    expect($('[data-ai-note="ok"]')!.textContent).toBe(appEn.mcpRevoked);
  });

  it('an unreadable list keeps the switch off and offers to clear it, after one confirm', async () => {
    const { api } = host({ store: 'blocked' });
    await show(api);
    await vi.waitFor(() => expect($('[data-ai-blocked]')).not.toBeNull());
    expect($<HTMLInputElement>('[data-ai-switch]')!.disabled).toBe(true);
    expect($('[data-ai-blocked]')!.textContent).toContain(appEn.mcpUnreadable);
    click('[data-ai-reset]');
    expect(api.resetClients).not.toHaveBeenCalled();
    expect($('[data-ai-reset-confirm]')!.textContent).toBe(appEn.mcpResetConfirm);
    click('[data-ai-reset-yes]');
    await vi.waitFor(() => expect($('[data-ai-blocked]')).toBeNull());
    expect(api.resetClients).toHaveBeenCalledOnce();
    expect($<HTMLInputElement>('[data-ai-switch]')!.disabled).toBe(false);
  });

  it('at the cap, Add is disabled and the reason is said in plain words', async () => {
    const six = Array.from({ length: MCP_MAX_CLIENTS }, (_, i) => ({ ...CLIENT, id: `mcp-${i}`, name: `App ${i}` }));
    const { api } = host({ enabled: true, store: 'ok', clients: 6 }, { clients: six });
    await show(api);
    await vi.waitFor(() => expect($('[data-ai-full]')).not.toBeNull());
    expect($<HTMLButtonElement>('[data-ai-add]')!.disabled).toBe(true);
    expect($('[data-ai-full]')!.textContent).toBe('You already have 6 AI apps. Remove one first, then add the new one.');
    expect(errorCopy('too_many_clients')).toBe('mcpTooMany');
  });

  it('on Linux the switch is disabled with the reason, and nothing else is offered', async () => {
    const { api } = host({ platform: 'no_sealer' });
    mount = document.createElement('div');
    document.body.appendChild(mount);
    dispose = render(() => <AiApps api={api} />, mount);
    await vi.waitFor(() => expect($('[data-ai-switch-hint]')!.textContent).toBe(appEn.mcpLinux));
    expect($<HTMLInputElement>('[data-ai-switch]')!.disabled).toBe(true);
    expect($('[data-ai-switch]')!.getAttribute('aria-describedby')).toBe($('[data-ai-switch-hint]')!.id);
    expect($('[data-ai-add]')).toBeNull();
    expect($('[data-ai-activity]')).toBeNull();
    expect(api.clients).not.toHaveBeenCalled();
  });

  it('the activity lists the newest rows in plain words, never the tool names apps send', async () => {
    const { api } = host({ enabled: true, store: 'ok' });
    api.audit.mockResolvedValue({
      rows: [
        { at_ms: 3, client: 'Desk helper', tool: 'read_balance', outcome: 'refused' },
        { at_ms: 2, client: null, tool: 'pairing_refused', outcome: 'not_authorised' },
        { at_ms: 1, client: 'Old helper', tool: 'client_removed', outcome: 'removed' },
        { at_ms: 0, client: 'Desk helper', tool: 'please_ignore_rules', outcome: 'refused' },
      ],
      unreadable: 2,
    });
    await show(api);
    const details = $('[data-ai-activity]') as HTMLDetailsElement;
    details.open = true;
    details.dispatchEvent(new Event('toggle'));
    await vi.waitFor(() => expect($$('[data-ai-activity-row]')).toHaveLength(4));
    const rows = $$('[data-ai-activity-row]').map(r => r.textContent!);
    // A topic this screen never offers still shows plainly when an app tries it.
    expect(rows[0]).toContain('Desk helper · Balance · Refused');
    expect(rows[1]).toContain('Unknown app · Asked to connect outside “Add an AI app” · Not allowed');
    expect(rows[2]).toContain('Old helper · Removed by you · Removed');
    expect(rows[3]).toContain('Other request');
    expect(rows[3]).not.toContain('please_ignore_rules');
    expect($('[data-ai-activity-skipped]')!.textContent).toBe('2 entries could not be read.');
  });

  it('an empty and a failed activity read are said plainly', async () => {
    const { api } = host({ enabled: true });
    api.audit.mockRejectedValue('unavailable');
    await show(api);
    const details = $('[data-ai-activity]') as HTMLDetailsElement;
    details.open = true;
    details.dispatchEvent(new Event('toggle'));
    await vi.waitFor(() => expect($('[data-ai-activity-error]')).not.toBeNull());
    expect($('[data-ai-activity-error]')!.textContent).toBe(appEn.mcpActivityError);
    api.audit.mockResolvedValue({ rows: [], unreadable: 0 });
    details.dispatchEvent(new Event('toggle'));
    await vi.waitFor(() => expect($('[data-ai-activity-empty]')).not.toBeNull());
  });

  it('Stop all asks the host and keeps the list', async () => {
    const { api } = host({ enabled: true, store: 'ok', clients: 1 }, { clients: [CLIENT] });
    await show(api);
    click('[data-ai-stop-all]');
    await vi.waitFor(() => expect($<HTMLInputElement>('[data-ai-switch]')!.checked).toBe(false));
    expect(api.stopAll).toHaveBeenCalledOnce();
    expect($('[data-ai-client="mcp-aa"]')).not.toBeNull();
  });

  it('nothing is approved without the owner’s click, and a new request clears the choices made for the old one', async () => {
    const { api, state, fire } = host({ enabled: true, pairing_open_s: 100, waiting: 1 }, { pending: [REQUEST] });
    await show(api);
    await vi.waitFor(() => expect($('[data-ai-request]')).not.toBeNull());
    toggle('[data-ai-topic="node"]');
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-ai-approve]')!.disabled).toBe(false));
    // Host events and reads alone never approve.
    fire();
    fire();
    await vi.waitFor(() => expect(api.pending.mock.calls.length).toBeGreaterThan(2));
    expect(api.approve).not.toHaveBeenCalled();
    // Another request replaces the first: its words show, nothing is ticked, Approve is off again.
    const other = { ...REQUEST, id: 'mcp-ffeeddccbbaa9988', words: ['copper', 'willow', 'meadow', 'signal', 'harbor', 'violet'] };
    state.pending = [other];
    fire();
    await vi.waitFor(() => expect($('[data-ai-request]')!.getAttribute('data-ai-request')).toBe(other.id));
    expect($$('[data-ai-words] li').map(li => li.textContent)).toEqual(other.words);
    expect($$('[data-ai-topic]').every(el => !(el as HTMLInputElement).checked)).toBe(true);
    expect($<HTMLButtonElement>('[data-ai-approve]')!.disabled).toBe(true);
    expect(api.approve).not.toHaveBeenCalled();
    toggle('[data-ai-topic="prices"]');
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-ai-approve]')!.disabled).toBe(false));
    click('[data-ai-approve]');
    await vi.waitFor(() => expect(api.approve).toHaveBeenCalledOnce());
    expect(api.approve).toHaveBeenCalledWith(other.id, ['prices'], 'counts');
  });

  it('after a failure midway, the screen says the switch was turned off and the list read again', async () => {
    const { api, state } = host();
    api.setEnabled.mockImplementationOnce(async () => {
      state.status = { ...state.status, enabled: false, start_error: 'recovered' };
      throw 'recovered';
    });
    await show(api);
    toggle('[data-ai-switch]');
    await vi.waitFor(() => expect($('[data-ai-note="err"]')).not.toBeNull());
    expect($('[data-ai-note="err"]')!.textContent).toBe(appEn.mcpRecovered);
    expect($<HTMLInputElement>('[data-ai-switch]')!.checked).toBe(false);
    dispose?.(); mount.remove();
    // Read later from the status alone, it says the same.
    const again = host({ start_error: 'recovered' });
    await show(again.api);
    expect($('[data-ai-start-error]')!.textContent).toBe(appEn.mcpRecovered);
    setLanguagePref('da');
    expect($('[data-ai-start-error]')!.textContent).toBe(appDa.mcpRecovered);
  });

  it('leaving the screen closes the pairing window even when it had not read one open', async () => {
    const { api } = host({ enabled: true });
    await show(api);
    dispose!();
    dispose = undefined;
    expect(api.closePairing).toHaveBeenCalledOnce();
  });

  it('leaving while “Add an AI app” is still on its way closes the window once it has opened', async () => {
    const { api, state } = host({ enabled: true });
    let finish!: () => void;
    api.openPairing.mockImplementationOnce(() => new Promise(resolve => {
      finish = () => { state.status = { ...state.status, pairing_open_s: 120 }; resolve(state.status); };
    }));
    await show(api);
    click('[data-ai-add]');
    expect(api.openPairing).toHaveBeenCalledOnce();
    dispose!();
    dispose = undefined;
    expect(api.closePairing).toHaveBeenCalledTimes(1);
    finish();
    await vi.waitFor(() => expect(api.closePairing).toHaveBeenCalledTimes(2));
    expect(state.status.pairing_open_s).toBeNull();
  });

  it('a quick second click on Approve does not reach the host again', async () => {
    const { api } = host({ enabled: true, pairing_open_s: 100, waiting: 1 }, { pending: [REQUEST] });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const status = api.status.getMockImplementation()!;
    await show(api);
    await vi.waitFor(() => expect($('[data-ai-request]')).not.toBeNull());
    toggle('[data-ai-topic="node"]');
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-ai-approve]')!.disabled).toBe(false));
    // The read after the approval is slow: the button must stay off until it lands.
    api.status.mockImplementation(async () => { await gate; return status(); });
    click('[data-ai-approve]');
    await vi.waitFor(() => expect(api.approve).toHaveBeenCalledOnce());
    await new Promise(r => setTimeout(r, 20));
    expect($<HTMLButtonElement>('[data-ai-approve]')?.disabled ?? true).toBe(true);
    $<HTMLButtonElement>('[data-ai-approve]')?.click();
    release();
    await vi.waitFor(() => expect($('[data-ai-request]')).toBeNull());
    expect(api.approve).toHaveBeenCalledOnce();
  });

  it('a window found open on arrival says it was left open, and can be stopped', async () => {
    const { api } = host({ enabled: true, pairing_open_s: 80 });
    await show(api);
    expect($('[data-ai-note="err"]')!.textContent).toBe(appEn.mcpWindowLeftOpen);
    expect($('[data-ai-window]')).not.toBeNull();
    click('[data-ai-window-cancel]');
    await vi.waitFor(() => expect($('[data-ai-window]')).toBeNull());
    expect(api.closePairing).toHaveBeenCalledOnce();
  });

  it('a window this screen opens itself is not called left open', async () => {
    const { api } = host({ enabled: true });
    await show(api);
    click('[data-ai-add]');
    await vi.waitFor(() => expect($('[data-ai-window]')).not.toBeNull());
    expect($('[data-ai-note="err"]')).toBeNull();
  });

  it('a close that fails on the way out is kept for diagnosis, not dropped', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { api } = host({ enabled: true, pairing_open_s: 90 });
      api.closePairing.mockRejectedValueOnce('unavailable');
      await show(api);
      dispose!();
      dispose = undefined;
      await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('mcp_close_pairing', 'unavailable'));
    } finally {
      warn.mockRestore();
    }
  });

  it('leaving the screen closes an open pairing window', async () => {
    const { api } = host({ enabled: true, pairing_open_s: 90 });
    await show(api);
    dispose!();
    dispose = undefined;
    expect(api.closePairing).toHaveBeenCalledOnce();
  });

  it('a failed switch-on shows the host’s reason, never raw text', async () => {
    const { api } = host();
    api.setEnabled.mockRejectedValueOnce('start_failed');
    await show(api);
    toggle('[data-ai-switch]');
    await vi.waitFor(() => expect($('[data-ai-note="err"]')).not.toBeNull());
    expect($('[data-ai-note="err"]')!.textContent).toBe(appEn.mcpStartFailed);
    expect($<HTMLInputElement>('[data-ai-switch]')!.checked).toBe(false);
  });

  it('shows Danish copy', async () => {
    setLanguagePref('da');
    const { api } = host({ enabled: true, pairing_open_s: 100, waiting: 1 }, { pending: [REQUEST] });
    await show(api);
    await vi.waitFor(() => expect($('[data-ai-warning]')).not.toBeNull());
    expect($('[data-ai-warning] p')!.textContent).toBe(appDa.mcpHonest);
    expect(appDa.mcpHonest.startsWith('Det, denne AI-app læser, kan forlade denne computer, også til firmaet bag AI’en.')).toBe(true);
    expect(appDa.mcpHonest).toContain('aldrig din saldo eller dine betalinger');
    expect($('[data-ai-counts-only]')!.textContent).toBe('Den ser hvor mange og kodenavne for dem, du er forbundet med: aldrig beløb, datoer eller rigtige id’er.');
    expect($('[data-ai-topic-hint="channels"]')!.textContent!.trim()).toBe('Hvem du er forbundet med (under et kodenavn), aldrig hvor meget.');
  });
});

describe('AI apps copy and codes', () => {
  it('every host error code has its own plain line; an unknown code gets the generic line', () => {
    const runtime = readFileSync('src-tauri/src/mcp/runtime.rs', 'utf8');
    const codes = [...runtime.slice(runtime.indexOf('pub mod code {'), runtime.indexOf('pub const DIR_NAME')).matchAll(/: &str = "([a-z_]+)";/g)].map(m => m[1]);
    expect(codes.length).toBeGreaterThan(10);
    expect(codes.sort()).toEqual([...MCP_ERROR_CODES].sort());
    for (const code of codes) expect(errorCopy(code)).not.toBe('mcpGenericError');
    expect(errorCopy('a raw host message')).toBe('mcpGenericError');
  });

  it('the audit names the host’s own tools and outcomes', () => {
    const endpoint = readFileSync('src-tauri/src/mcp/endpoint.rs', 'utf8');
    expect(endpoint).toContain('pub const REMOVED_AUDIT_TOOL: &str = "client_removed";');
    expect(readFileSync('src-tauri/src/mcp/runtime.rs', 'utf8')).toContain('pub const PAIRING_REFUSED_TOOL: &str = "pairing_refused";');
    expect(auditWhat('read_inbox_counts')).toBe('mcpTopicInbox');
  });

  it('no line over-promises, in either language', () => {
    const lines = Object.entries({ ...appEn }).filter(([k]) => k.startsWith('mcp')).map(([, v]) => v)
      .concat(Object.entries({ ...appDa }).filter(([k]) => k.startsWith('mcp')).map(([, v]) => v));
    expect(lines.length).toBeGreaterThan(100);
    for (const line of lines) {
      expect(line).not.toMatch(/at once|only apps you approve|nothing changed|med det samme|kun apps, du godkender|intet er ændret/i);
    }
  });
});
