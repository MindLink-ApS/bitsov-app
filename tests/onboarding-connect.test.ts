import { afterEach, expect, it, vi } from 'vitest';
import { hostSource } from '../src/control/source';
import * as scanner from '../src/pairingScanner';

afterEach(() => vi.unstubAllGlobals());
it('uses the no-restart host command for both existing confirmed entry points', async () => {
  const commands: string[] = [];
  vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (cmd: string) => { commands.push(cmd); return { restart_required: false }; } });
  expect((await hostSource.remoteAccessImport('synthetic')).restart_required).toBe(false);
  expect((await hostSource.remoteAccessReplace('synthetic')).restart_required).toBe(false);
  expect(commands).toEqual(['remote_access_connect', 'remote_access_connect']);
});
it('exposes the scanner on iPhone and desktop-UA iPad', () => {
  vi.stubGlobal('__TAURI_INTERNALS__', {});
  expect(scanner.mobileQrScannerAvailable('Mozilla/5.0 (iPhone)', 5)).toBe(true);
  expect(scanner.mobileQrScannerAvailable('Mozilla/5.0 (Macintosh)', 5)).toBe(true);
  expect(scanner.mobileQrScannerAvailable('Mozilla/5.0 (Macintosh)', 0)).toBe(false);
});

it('keeps desktop first-owner setup on the established import path', async () => {
  const commands: string[] = [];
  vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (cmd: string) => {
    commands.push(cmd);
    if (cmd === 'remote_access_connect') throw { kind: 'unclaimed', detail: 'Setup required' };
    return { restart_required: true };
  } });
  expect((await hostSource.remoteAccessImport('synthetic')).restart_required).toBe(true);
  expect(commands).toEqual(['remote_access_connect', 'remote_access_import']);
});

it('preserves next-start import when desktop has a local node selected', async () => {
  const commands: string[] = [];
  vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (cmd: string) => {
    commands.push(cmd);
    if (cmd === 'remote_access_connect') throw { kind: 'busy', detail: 'Busy' };
    if (cmd === 'pairing_status') return { remote: false };
    return { restart_required: true };
  } });
  expect((await hostSource.remoteAccessImport('synthetic')).restart_required).toBe(true);
  expect(commands).toEqual(['remote_access_connect', 'pairing_status', 'remote_access_import']);
});
