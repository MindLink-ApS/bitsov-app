import { expect, it } from 'vitest';
import config, { iosStoreFlag, starterBalanceFlag } from '../vite.config';

it.each([
  [{ TAURI_ENV_PLATFORM: 'ios' }, '1'],
  [{ TAURI_ENV_PLATFORM: 'ios', TAURI_ENV_DEBUG: 'false' }, '1'],
  [{ TAURI_ENV_PLATFORM: 'ios', TAURI_ENV_DEBUG: 'true' }, '0'],
  [{ TAURI_ENV_PLATFORM: 'darwin' }, '0'],
  [{ TAURI_ENV_PLATFORM: 'windows' }, '0'],
  [{ TAURI_ENV_PLATFORM: 'linux' }, '0'],
  [{ TAURI_ENV_PLATFORM: 'android' }, '0'],
  [{}, '0'],
] as const)('derives the immutable store profile from the Tauri target (%j)', (env, expected) => {
  expect(iosStoreFlag(env)).toBe(expected);
  // A Vite dotenv or process override cannot switch the profile.
  expect(iosStoreFlag({ ...env, VITE_IOS_STORE: expected === '1' ? '0' : '1' })).toBe(expected);
});

it('excludes starter balance even if requested in an iOS store build', () => {
  expect(starterBalanceFlag({ TAURI_ENV_PLATFORM: 'ios', VITE_STARTER_BALANCE: '1' })).toBe('0');
  expect(config.define?.['import.meta.env.VITE_IOS_STORE']).toBe(JSON.stringify(iosStoreFlag(process.env)));
});
