import { createEffect, createSignal, createUniqueId, For, onCleanup, onMount, Show } from 'solid-js';
import { language, t, type CopyKey } from '../i18n';
import {
  auditOutcome, auditWhat, clock, errorCode, errorCopy, MCP_MAX_CLIENTS, MCP_TOOL_NAME, MCP_TOPICS, TOPIC_COPY,
  type AiAppsApi, type McpAuditPage, type McpClient, type McpPending, type McpPreset, type McpStatus, type McpTopic,
} from './aiAppsApi';

/** How often the screen reads the host while it is open and the switch is on. */
export const AI_APPS_POLL_MS = 2_000;

type Note = { key: CopyKey; values?: (string | number)[]; tone: 'ok' | 'err' };

/**
 * Settings → AI apps (ADR H3953 A1): the owner's switch, the pairing window
 * the owner opens, the request with its six words, the approved apps, and the
 * activity. Every decision is the host's; this screen only shows and asks.
 * Leaving the screen closes an open pairing window, so a request can only
 * arrive while the owner is looking at it.
 */
export function AiApps(props: { api: AiAppsApi; now?: () => number }) {
  const now = () => props.now?.() ?? Date.now();
  const [status, setStatus] = createSignal<McpStatus | null>(null);
  const [pending, setPending] = createSignal<McpPending | null>(null);
  const [clients, setClients] = createSignal<McpClient[]>([]);
  const [audit, setAudit] = createSignal<McpAuditPage | null>(null);
  const [auditFailed, setAuditFailed] = createSignal(false);
  const [auditOpen, setAuditOpen] = createSignal(false);
  const [note, setNote] = createSignal<Note | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [confirmReset, setConfirmReset] = createSignal(false);
  const [confirmRemove, setConfirmRemove] = createSignal<string | null>(null);
  const [topics, setTopics] = createSignal<McpTopic[]>([]);
  const [preset, setPreset] = createSignal<McpPreset>('counts');
  // Countdowns run locally from the host's seconds and the time they were read.
  const [readAt, setReadAt] = createSignal(now());
  const [tick, setTick] = createSignal(now());
  let requestHeading: HTMLHeadingElement | undefined;
  const ids = { title: createUniqueId(), switchHint: createUniqueId(), request: createUniqueId(), topics: createUniqueId(), preset: createUniqueId() };

  const say = (key: CopyKey, tone: Note['tone'] = 'err', ...values: (string | number)[]) => setNote({ key, tone, values });
  const fail = (error: unknown, override?: Partial<Record<string, CopyKey>>) => {
    const code = errorCode(error);
    const key = override?.[code] ?? errorCopy(code);
    say(key, 'err', ...(code === 'too_many_clients' ? [MCP_MAX_CLIENTS] : []));
  };

  async function refresh() {
    try {
      const next = await props.api.status();
      setStatus(next);
      setReadAt(now());
      setTick(now());
      const usable = next.platform === 'ok' && next.store !== 'blocked';
      const request = next.enabled && next.waiting > 0 ? (await props.api.pending())[0] ?? null : null;
      if (request && request.id !== pending()?.id) { setTopics([]); setPreset('counts'); queueMicrotask(() => requestHeading?.focus()); }
      setPending(request);
      setClients(usable ? await props.api.clients() : []);
      if (auditOpen()) await loadAudit();
    } catch (error) {
      fail(error);
    }
  }

  async function loadAudit() {
    try { setAudit(await props.api.audit()); setAuditFailed(false); } catch { setAuditFailed(true); }
  }

  async function act<T>(run: () => Promise<T>, done?: (value: T) => void, override?: Partial<Record<string, CopyKey>>) {
    if (busy()) return;
    setBusy(true);
    setNote(null);
    try {
      // Run first: `done?.(await run())` would skip the call when there is no `done`.
      const value = await run();
      done?.(value);
    } catch (error) {
      fail(error, override);
    } finally {
      setBusy(false);
      await refresh();
    }
  }

  // An "Add an AI app" call still on its way to the host.
  let opening: Promise<unknown> | null = null;
  const closePairing = () => props.api.closePairing().then(() => undefined, (error: unknown) => {
    // Nothing is left on screen to say it: keep the code for diagnosis.
    console.warn('mcp_close_pairing', errorCode(error));
  });

  onMount(() => {
    void refresh();
    const stopListening = props.api.onChanged(() => void refresh());
    const poll = setInterval(() => { if (status()?.enabled) void refresh(); }, AI_APPS_POLL_MS);
    const second = setInterval(() => setTick(now()), 1_000);
    onCleanup(() => {
      stopListening();
      clearInterval(poll);
      clearInterval(second);
      // A pairing window is open only while the owner is on this screen.
      // Always close (the host's close is idempotent), whatever this screen
      // last read; and close again once an open still on its way settles.
      void closePairing();
      if (opening) void opening.then(closePairing, closePairing);
    });
  });

  const elapsed = () => Math.max(0, Math.floor((tick() - readAt()) / 1000));
  const windowLeft = () => Math.max(0, (status()?.pairing_open_s ?? 0) - elapsed());
  const requestLeft = () => Math.max(0, (pending()?.expires_in_s ?? 0) - elapsed());
  const windowOpen = () => status()?.pairing_open_s != null && windowLeft() > 0;
  const full = () => clients().length >= MCP_MAX_CLIENTS;
  const unavailable = () => status()?.platform === 'no_sealer';
  const blocked = () => status()?.store === 'blocked';
  // A request that ran out while shown: say so once, then drop it.
  createEffect(() => {
    if (pending() && requestLeft() === 0) { setPending(null); say('mcpRequestGone'); }
  });

  const date = (ms: number) => new Date(ms).toLocaleDateString(language() === 'da' ? 'da-DK' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const time = (ms: number) => new Date(ms).toLocaleString(language() === 'da' ? 'da-DK' : 'en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const startError = () => {
    const code = status()?.start_error;
    return code ? errorCopy(code) : null;
  };

  const toggleTopic = (topic: McpTopic, on: boolean) =>
    setTopics(current => on ? MCP_TOPICS.filter(t => t === topic || current.includes(t)) : current.filter(t => t !== topic));

  return <section class="ai-apps" data-ai-apps data-ai-ready={status() && !busy() ? '' : undefined} aria-labelledby={ids.title}>
    <h2 id={ids.title}>{t('mcpTitle')}</h2>
    <label class="ai-apps-switch">
      <input type="checkbox" role="switch" data-ai-switch
        checked={status()?.enabled ?? false} aria-checked={status()?.enabled ?? false}
        disabled={busy() || !status() || unavailable() || blocked()} aria-describedby={ids.switchHint}
        onChange={e => {
          const on = e.currentTarget.checked;
          e.currentTarget.checked = status()?.enabled ?? false;
          void act(() => props.api.setEnabled(on));
        }} />
      <span>{t('mcpSwitch')}</span>
    </label>
    <p class="hint" id={ids.switchHint} data-ai-switch-hint>{unavailable() ? t('mcpLinux') : t('mcpSwitchHint')}</p>

    <Show when={note()}>{n => <p role={n().tone === 'ok' ? 'status' : 'alert'} class={n().tone === 'ok' ? 'ok-note' : 'err-note'} data-ai-note={n().tone}>{t(n().key, ...(n().values ?? []))}</p>}</Show>
    <Show when={!note() && !status()?.unsaved_revoke ? startError() : null}>{key => <p role="alert" class="err-note" data-ai-start-error>{t(key())}</p>}</Show>

    <Show when={blocked()}>
      <div class="ai-apps-block" data-ai-blocked>
        <p role="alert" class="err-note">{t('mcpUnreadable')}</p>
        <Show when={!confirmReset()} fallback={<>
          <p class="hint" data-ai-reset-confirm>{t('mcpResetConfirm')}</p>
          <div class="row ai-apps-actions">
            <button type="button" class="primary" data-ai-reset-yes disabled={busy()}
              onClick={() => void act(() => props.api.resetClients(), () => setConfirmReset(false), { not_saved: 'mcpGenericError' })}>{t('mcpResetYes')}</button>
            <button type="button" class="soft" data-ai-reset-cancel disabled={busy()} onClick={() => setConfirmReset(false)}>{t('mcpCancel')}</button>
          </div>
        </>}>
          <button type="button" class="soft" data-ai-reset disabled={busy()} onClick={() => setConfirmReset(true)}>{t('mcpResetClients')}</button>
        </Show>
      </div>
    </Show>

    <Show when={status()?.unsaved_revoke}>
      <div class="ai-apps-block" data-ai-unsaved>
        <p role="alert" class="err-note">{t('mcpRevokeNotSaved')}</p>
        <button type="button" class="primary" data-ai-save-again disabled={busy()}
          onClick={() => void act(() => props.api.saveAgain(), r => r.saved ? say('mcpRevoked', 'ok') : say('mcpStillNotSaved'))}>{t('mcpSaveAgain')}</button>
      </div>
    </Show>

    <Show when={status()?.enabled && !blocked()}>
      <Show when={!pending()}>
        <Show when={windowOpen()} fallback={<>
          <p class="hint" data-ai-howto>{t('mcpHowTo')}</p>
          <Show when={full()}><p class="hint" data-ai-full>{t('mcpTooMany', MCP_MAX_CLIENTS)}</p></Show>
          <button type="button" class="primary ai-apps-add" data-ai-add disabled={busy() || full()}
            onClick={() => void act(() => {
              const open = props.api.openPairing();
              opening = open;
              return open.finally(() => { if (opening === open) opening = null; });
            })}>{t('mcpAdd')}</button>
        </>}>
          <p role="status" data-ai-window>{t('mcpWindowOpen', clock(windowLeft()))}</p>
          <p class="hint">{t('mcpHowTo')}</p>
          <button type="button" class="soft" data-ai-window-cancel disabled={busy()}
            onClick={() => void act(() => props.api.closePairing())}>{t('mcpWindowCancel')}</button>
        </Show>
      </Show>
      <details class="quiet-detail" data-ai-setup>
        <summary>{t('mcpSetupFor')}</summary>
        <p>{t('mcpSetupSteps', MCP_TOOL_NAME)}</p>
      </details>
    </Show>

    <Show when={pending()}>{request => <section class="ai-apps-request" data-ai-request={request().id} aria-labelledby={ids.request}>
      <h3 id={ids.request} tabindex="-1" ref={requestHeading}>{t('mcpPairTitle', request().name)}</h3>
      <p class="hint" data-ai-name-note>{t('mcpNameNote')}</p>
      <p class="ai-apps-words-label">{t('mcpWordsLabel')}</p>
      <ol class="ai-apps-words" data-ai-words>
        <For each={request().words}>{word => <li>{word}</li>}</For>
      </ol>
      <p data-ai-words-check>{t('mcpWordsCheck')}</p>
      <Show when={request().others_refused > 0}><p role="alert" class="err-note" data-ai-others>{t('mcpOthersTried')}</p></Show>
      <fieldset class="ai-apps-choices" data-ai-topics aria-describedby={ids.topics}>
        <legend>{t('mcpTopicsLabel')}</legend>
        <For each={MCP_TOPICS}>{topic => <label>
          <input type="checkbox" data-ai-topic={topic} checked={topics().includes(topic)} disabled={busy()}
            onChange={e => toggleTopic(topic, e.currentTarget.checked)} /> {t(TOPIC_COPY[topic])}
        </label>}</For>
        <Show when={topics().length === 0}><p class="hint" id={ids.topics} data-ai-pick-one>{t('mcpPickOne')}</p></Show>
      </fieldset>
      <fieldset class="ai-apps-choices" data-ai-presets>
        <legend>{t('mcpDetailLabel')}</legend>
        <label><input type="radio" name={ids.preset} data-ai-preset="counts" checked={preset() === 'counts'} disabled={busy()}
          onChange={() => setPreset('counts')} /> {t('mcpPresetCounts')}<span class="hint"> {t('mcpPresetCountsHint')}</span></label>
        <label><input type="radio" name={ids.preset} data-ai-preset="rounded" checked={preset() === 'rounded'} disabled={busy()}
          onChange={() => setPreset('rounded')} /> {t('mcpPresetRounded')}<span class="hint"> {t('mcpPresetRoundedHint')}</span></label>
        <p class="hint" data-ai-no-exact>{t('mcpNoExact')}</p>
      </fieldset>
      <div role="note" class="ai-apps-warning" data-ai-warning>
        <p>{t('mcpHonest')}</p>
        <details class="quiet-detail" data-ai-warning-more>
          <summary>{t('mcpHonestMore')}</summary>
          <p>{t('mcpHonestAdr')}</p>
        </details>
      </div>
      <div class="row ai-apps-actions">
        <button type="button" class="primary" data-ai-approve disabled={busy() || topics().length === 0}
          onClick={() => void act(() => props.api.approve(request().id, topics(), preset()), () => say('mcpApproved', 'ok'))}>{t('mcpApprove')}</button>
        <button type="button" class="soft" data-ai-deny disabled={busy()}
          onClick={() => void act(() => props.api.deny(request().id), () => say('mcpDenied', 'ok'))}>{t('mcpDeny')}</button>
      </div>
      <p class="hint" data-ai-expires>{t('mcpExpires', clock(requestLeft()))}</p>
    </section>}</Show>

    <Show when={!unavailable() && !blocked() && status()}>
      <h3>{t('mcpClientsTitle')}</h3>
      <Show when={clients().length > 0} fallback={<p class="hint" data-ai-no-clients>{t('mcpNoClients')}</p>}>
        <ul class="ai-apps-clients" data-ai-clients>
          <For each={clients()}>{client => <li data-ai-client={client.id}>
            <strong>{client.name}</strong>
            <p class="hint">{client.topics.map(topic => t(TOPIC_COPY[topic])).join(', ')}</p>
            <p class="hint">{t(client.preset === 'rounded' ? 'mcpPresetRounded' : 'mcpPresetCounts')} · {t('mcpAdded', date(client.created_ms))}</p>
            <Show when={confirmRemove() === client.id} fallback={
              <button type="button" class="soft" data-ai-remove={client.id} disabled={busy()} onClick={() => setConfirmRemove(client.id)}>{t('mcpRemove')}</button>
            }>
              <p data-ai-remove-confirm>{t('mcpRevokeConfirm', client.name)}</p>
              <div class="row ai-apps-actions">
                <button type="button" class="primary" data-ai-remove-yes disabled={busy()}
                  onClick={() => void act(() => props.api.revoke(client.id), r => { setConfirmRemove(null); if (r.saved) say('mcpRevoked', 'ok'); })}>{t('mcpRemove')}</button>
                <button type="button" class="soft" data-ai-remove-cancel disabled={busy()} onClick={() => setConfirmRemove(null)}>{t('mcpCancel')}</button>
              </div>
            </Show>
          </li>}</For>
        </ul>
      </Show>
    </Show>

    <Show when={status()?.enabled}>
      <button type="button" class="soft" data-ai-stop-all disabled={busy()} onClick={() => void act(() => props.api.stopAll())}>{t('mcpStopAll')}</button>
      <p class="hint">{t('mcpStopAllHint')}</p>
    </Show>

    <Show when={!unavailable() && status()}>
      <details class="quiet-detail" data-ai-activity onToggle={e => { setAuditOpen(e.currentTarget.open); if (e.currentTarget.open) void loadAudit(); }}>
        <summary>{t('mcpActivity')}</summary>
        <Show when={!auditFailed()} fallback={<p class="err-note" data-ai-activity-error>{t('mcpActivityError')}</p>}>
          <Show when={(audit()?.unreadable ?? 0) > 0}><p class="hint" data-ai-activity-skipped>{t('mcpActivitySkipped', audit()!.unreadable)}</p></Show>
          <Show when={(audit()?.rows.length ?? 0) > 0} fallback={<p class="hint" data-ai-activity-empty>{t('mcpActivityEmpty')}</p>}>
            <ul class="ai-apps-activity" data-ai-activity-rows>
              <For each={audit()!.rows.slice(0, 200)}>{row => <li data-ai-activity-row>
                {time(row.at_ms)} · {row.client ?? t('mcpUnknownClient')} · {t(auditWhat(row.tool))} · {t(auditOutcome(row.outcome))}
              </li>}</For>
            </ul>
          </Show>
        </Show>
      </details>
    </Show>
  </section>;
}
