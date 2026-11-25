import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { CopyKey } from '../i18n';
import { isMobilePlatform } from '../platform';

/** What an AI app may read (the host's `ai::Topic`, snake_case). */
export type McpTopic = 'node' | 'prices' | 'balance' | 'channels' | 'payments' | 'inbox';
/** The host's R2 preset: there is no `exact` on this side either. */
export type McpPreset = 'counts' | 'rounded';

export type McpStatus = {
  platform: 'ok' | 'no_sealer';
  enabled: boolean;
  store: 'ok' | 'empty' | 'blocked';
  start_error: string | null;
  pairing_open_s: number | null;
  waiting: number;
  clients: number;
  unsaved_revoke: boolean;
};
export type McpPending = { id: string; name: string; words: string[]; expires_in_s: number; others_refused: number };
export type McpClient = { id: string; name: string; topics: McpTopic[]; preset: McpPreset; created_ms: number };
export type McpAuditRow = { at_ms: number; client: string | null; tool: string; outcome: string };
export type McpAuditPage = { rows: McpAuditRow[]; unreadable: number };

/** The host's commands (`src-tauri/src/mcp/runtime.rs`). Each rejects with a short code. */
export interface AiAppsApi {
  status(): Promise<McpStatus>;
  setEnabled(on: boolean): Promise<McpStatus>;
  openPairing(): Promise<McpStatus>;
  closePairing(): Promise<McpStatus>;
  pending(): Promise<McpPending[]>;
  approve(id: string, topics: McpTopic[], preset: McpPreset): Promise<McpClient>;
  deny(id: string): Promise<boolean>;
  clients(): Promise<McpClient[]>;
  revoke(id: string): Promise<{ saved: boolean }>;
  saveAgain(): Promise<{ saved: boolean }>;
  stopAll(): Promise<McpStatus>;
  audit(): Promise<McpAuditPage>;
  resetClients(): Promise<McpStatus>;
  /** Calls `changed` on the host's `mcp-changed` event; returns the unsubscribe. */
  onChanged(changed: () => void): () => void;
}

/** The host keeps at most this many approved apps (`store::MAX_CLIENTS`). */
export const MCP_MAX_CLIENTS = 6;
/** The bundled tool an AI app starts (named, never run, by this app). */
export const MCP_TOOL_NAME = 'bitsov-mcp';
/** Topics in the order shown: the least sensitive first. */
export const MCP_TOPICS: readonly McpTopic[] = ['node', 'prices', 'balance', 'channels', 'payments', 'inbox'];

export const TOPIC_COPY: Record<McpTopic, CopyKey> = {
  node: 'mcpTopicNode', prices: 'mcpTopicPrices', balance: 'mcpTopicBalance',
  channels: 'mcpTopicChannels', payments: 'mcpTopicPayments', inbox: 'mcpTopicInbox',
};

/** The host's error codes, each to plain copy. Unknown codes get the generic line, never raw text. */
const ERROR_COPY: Record<string, CopyKey> = {
  main_window_only: 'mcpMainWindowOnly',
  unavailable: 'mcpTurnOnFirst',
  blocked: 'mcpUnreadable',
  start_failed: 'mcpStartFailed',
  unknown: 'mcpRequestGone',
  no_topics: 'mcpPickOne',
  preset_too_wide: 'mcpNoExact',
  not_saved: 'mcpApproveNotSaved',
  too_many_clients: 'mcpTooMany',
  removal_not_saved: 'mcpRevokeNotSaved',
  pairing_closed: 'mcpRequestGone',
  recovered: 'mcpRecovered',
};
export const MCP_ERROR_CODES = Object.keys(ERROR_COPY);

export function errorCode(error: unknown): string {
  return typeof error === 'string' ? error : error instanceof Error ? error.message : '';
}

export function errorCopy(code: string): CopyKey {
  return Object.prototype.hasOwnProperty.call(ERROR_COPY, code) ? ERROR_COPY[code] : 'mcpGenericError';
}

const TOOL_TOPIC: Record<string, McpTopic> = {
  read_node: 'node', read_prices: 'prices', read_balance: 'balance',
  read_channels: 'channels', read_payments: 'payments', read_inbox_counts: 'inbox',
};

/** What an audit row did, in plain words. Client-supplied tool names are never shown. */
export function auditWhat(tool: string): CopyKey {
  if (Object.prototype.hasOwnProperty.call(TOOL_TOPIC, tool)) return TOPIC_COPY[TOOL_TOPIC[tool]];
  if (tool === 'handshake') return 'mcpConnRefused';
  if (tool === 'pairing_refused') return 'mcpPairRefused';
  if (tool === 'client_removed') return 'mcpAuditRemoved';
  return 'mcpAuditOther';
}

const OUTCOME_COPY: Record<string, CopyKey> = {
  read: 'mcpOutcomeRead', read_failed: 'mcpOutcomeReadFailed', refused: 'mcpOutcomeRefused',
  rate_limited: 'mcpOutcomeRateLimited', not_authorised: 'mcpOutcomeNotAuthorised', removed: 'mcpOutcomeRemoved',
};

export function auditOutcome(outcome: string): CopyKey {
  return Object.prototype.hasOwnProperty.call(OUTCOME_COPY, outcome) ? OUTCOME_COPY[outcome] : 'mcpOutcomeRefused';
}

/** m:ss for a countdown. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The commands, over Tauri. */
export const tauriAiApps: AiAppsApi = {
  status: () => invoke('mcp_status'),
  setEnabled: on => invoke('mcp_set_enabled', { on }),
  openPairing: () => invoke('mcp_open_pairing'),
  closePairing: () => invoke('mcp_close_pairing'),
  pending: () => invoke('mcp_pending'),
  approve: (id, topics, preset) => invoke('mcp_approve', { id, topics, preset }),
  deny: id => invoke('mcp_deny', { id }),
  clients: () => invoke('mcp_clients'),
  revoke: id => invoke('mcp_revoke', { id }),
  saveAgain: () => invoke('mcp_save_again'),
  stopAll: () => invoke('mcp_stop_all'),
  audit: () => invoke('mcp_audit'),
  resetClients: () => invoke('mcp_reset_clients', { confirm: true }),
  onChanged: changed => {
    let stop: (() => void) | null = null;
    let closed = false;
    void listen('mcp-changed', () => changed()).then(unlisten => { if (closed) unlisten(); else stop = unlisten; }).catch(() => {});
    return () => { closed = true; stop?.(); };
  },
};

/**
 * Whether this build has the AI apps commands: desktop only, and only when the
 * host registered them (the `mcp-grant` feature). Linux answers too, with
 * `no_sealer`, so its switch is shown disabled with the reason.
 */
export async function aiAppsAvailable(api: AiAppsApi = tauriAiApps): Promise<boolean> {
  if (!isTauri() || isMobilePlatform()) return false;
  try {
    await api.status();
    return true;
  } catch {
    return false;
  }
}
