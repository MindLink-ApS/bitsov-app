import { expect, it } from 'vitest';
import config, { starterBalanceFlag } from '../vite.config';

it.each([undefined, '', '0', 'true', 'yes', '1'])('enables starter only for process VITE_STARTER_BALANCE=1 (%s)', value => {
  expect(starterBalanceFlag({ VITE_STARTER_BALANCE: value })).toBe(value === '1' ? '1' : '0');
});
it('overrides Vite dotenv loading with the shared build-process flag', () => {
  expect(config.define?.['import.meta.env.VITE_STARTER_BALANCE']).toBe(JSON.stringify(starterBalanceFlag(process.env)));
});
