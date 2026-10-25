import { afterEach, describe, expect, it } from 'vitest';
import { softenError } from '../src/control/userFacing';
import { setLanguagePref } from '../src/i18n';
afterEach(() => setLanguagePref('en'));

it.each([
  ['en', 'This beta uses signet; mainnet is disabled.'],
  ['da', 'Denne beta bruger signet; mainnet er deaktiveret.'],
] as const)('explains the beta network refusal in %s', (language, reason) => {
  setLanguagePref(language);
  expect(softenError('beta_mainnet_disabled').summary).toBe(reason);
  setLanguagePref('en');
});

it.each([
  ['en', 'The node did not confirm its test network; setup is blocked.'],
  ['da', 'Noden bekræftede ikke sit testnetværk; opsætningen er blokeret.'],
] as const)('explains an unknown or absent network in %s', (language, reason) => {
  setLanguagePref(language);
  expect(softenError('beta_network_unknown')).toEqual({ summary: reason, detail: null, money: true });
});

describe('softenError', () => {
  it('maps introduction_unavailable to a plain public-address sentence', () => {
    const soft = softenError(
      'introduction_unavailable: no dialable peer endpoint; set [network] advertised_addr',
    );
    expect(soft.summary).toBe('We could not find a public address for your node yet.');
    expect(soft.detail).toContain('introduction_unavailable');
    expect(soft.detail).toContain('advertised_addr');

    const softBare = softenError('introduction_unavailable');
    expect(softBare.summary).toBe('We could not find a public address for your node yet.');
    expect(softBare.detail).toBe('introduction_unavailable');

    const softSnake = softenError('error: no_dialable_peer_endpoint');
    expect(softSnake.summary).toBe('We could not find a public address for your node yet.');
  });

  it('leaves ordinary sentences alone', () => {
    expect(softenError('Select and copy the link above.')).toEqual({
      summary: 'Select and copy the link above.',
      detail: null,
    });
  });
});

 it.each([
   'remote_retry_wait: Remote connection unavailable; waiting 3 s',
   '/status failed (503): remote_retry_wait: Remote connection unavailable; waiting 3 s',
   'rate_limited: Remote connection unavailable; waiting 3 s',
 ])('keeps the remote retry countdown readable: %s', (raw) => {
   expect(softenError(raw)).toEqual({ summary: 'Remote connection unavailable · waiting 3 s', detail: raw });
 });
