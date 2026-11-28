import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiAppsApi, McpStatus } from '../src/control/aiAppsApi';

// The AI apps tab shows only in the desktop app, and only when the host
// answers: a build without the commands, a phone or a browser never shows it.

const env = vi.hoisted(() => ({ tauri: true, mobile: false }));
vi.mock('@tauri-apps/api/core', async (actual) => ({
  ...(await actual<typeof import('@tauri-apps/api/core')>()),
  isTauri: () => env.tauri,
}));
vi.mock('../src/platform', async (actual) => ({
  ...(await actual<typeof import('../src/platform')>()),
  isMobilePlatform: () => env.mobile,
}));

const { aiAppsAvailable } = await import('../src/control/aiAppsApi');

const STATUS: McpStatus = { platform: 'ok', enabled: false, store: 'empty', start_error: null, pairing_open_s: null, waiting: 0, clients: 0, unsaved_revoke: false };
const api = (status: AiAppsApi['status']) => ({ status } as unknown as AiAppsApi);

afterEach(() => { env.tauri = true; env.mobile = false; });

describe('aiAppsAvailable', () => {
  it('is true in the desktop app when the host answers', async () => {
    const status = vi.fn(async () => STATUS);
    expect(await aiAppsAvailable(api(status))).toBe(true);
    expect(status).toHaveBeenCalledOnce();
  });

  it('is false outside the app, and never asks the host', async () => {
    env.tauri = false;
    const status = vi.fn(async () => STATUS);
    expect(await aiAppsAvailable(api(status))).toBe(false);
    expect(status).not.toHaveBeenCalled();
  });

  it('is false on a phone, and never asks the host', async () => {
    env.mobile = true;
    const status = vi.fn(async () => STATUS);
    expect(await aiAppsAvailable(api(status))).toBe(false);
    expect(status).not.toHaveBeenCalled();
  });

  it('is false when the host refuses or has no such command', async () => {
    for (const error of ['main_window_only', 'Command mcp_status not found', new Error('ipc down')]) {
      const status = vi.fn(async () => { throw error; });
      expect(await aiAppsAvailable(api(status))).toBe(false);
    }
  });

  it('answers on Linux too, so the switch can say why it is off', async () => {
    const status = vi.fn(async () => ({ ...STATUS, platform: 'no_sealer' as const }));
    expect(await aiAppsAvailable(api(status))).toBe(true);
  });
});
