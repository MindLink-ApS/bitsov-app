import { describe, expect, it } from 'vitest';
import { softenError } from '../src/control/userFacing';

describe('softenError', () => {
  it('maps introduction_unavailable to a plain public-address sentence', () => {
    const soft = softenError(
      'introduction_unavailable: no dialable peer endpoint; set [network] advertised_addr',
    );
    expect(soft.summary).toBe('We could not find a public address for your box yet.');
    expect(soft.detail).toContain('introduction_unavailable');
    expect(soft.detail).toContain('advertised_addr');

    const softBare = softenError('introduction_unavailable');
    expect(softBare.summary).toBe('We could not find a public address for your box yet.');
    expect(softBare.detail).toBe('introduction_unavailable');

    const softSnake = softenError('error: no_dialable_peer_endpoint');
    expect(softSnake.summary).toBe('We could not find a public address for your box yet.');
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
