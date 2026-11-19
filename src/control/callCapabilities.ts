/**
 * What this node, and the caller's node, can do for a call, read from the
 * capabilities they advertise. Each is used only by its exact name, and none
 * is assumed for a node that does not list it (an older node lists none).
 *
 * - `call_continuity_v1` (our node's `/status`): an admitted call keeps its
 *   media and draws its minutes on the hold pinned at admission after its
 *   grant expires or is renewed. A revoke still ends it. Continuity is per
 *   node: a caller's older node can still cut its own side.
 * - `call_reply_free_v1` (our node's `/status`, and the caller's handshake as
 *   the host derives it into `Peer.free_replies`): the answer and the
 *   declined hangup to a ringing call go out free. Both nodes must list it.
 * - `standing_allowance_v1` (our node's `/status`): read only. It proves no
 *   live allowance and no funds: a call is ready only with a live grant,
 *   which on such a node the box may open under the allowance by itself.
 */
import { windowEndsBeforeCall } from './call';
import type { NodeGrantSummary, Peer } from './types';

export const CALL_CONTINUITY_CAPABILITY = 'call_continuity_v1';
export const FREE_REPLY_CAPABILITY = 'call_reply_free_v1';
export const STANDING_ALLOWANCE_CAPABILITY = 'standing_allowance_v1';

const lists = (caps: readonly string[] | null | undefined, name: string) => Array.isArray(caps) && caps.includes(name);

export const callContinuity = (caps: readonly string[] | null | undefined): boolean => lists(caps, CALL_CONTINUITY_CAPABILITY);
export const standingAllowance = (caps: readonly string[] | null | undefined): boolean => lists(caps, STANDING_ALLOWANCE_CAPABILITY);
/** Our node and the caller's node (connected now) both take free call replies. */
export const freeReplies = (caps: readonly string[] | null | undefined, peer: Peer | null | undefined): boolean =>
  lists(caps, FREE_REPLY_CAPABILITY) && peer?.connected === true && peer.free_replies === true;

export type CallReadiness = { ready: true } | { ready: false; reason: 'no_grant' } | { ready: false; reason: 'window_short'; minutesLeft: number };

/**
 * Ready for calls only with a live grant (unexpired, something left) that can
 * carry a call: on a node without continuity it must also outlast the call
 * limit (240 minutes while unknown), as the call window requires.
 */
export function callReadiness(input: { grant: NodeGrantSummary | null | undefined; now: number; continuity: boolean; limitMinutes?: number | null }): CallReadiness {
  const { grant, now, continuity } = input;
  if (!grant || !Number.isFinite(grant.expires_at_ms) || grant.expires_at_ms <= now || !(grant.remaining_msat > 0)) return { ready: false, reason: 'no_grant' };
  if (!continuity) {
    const left = windowEndsBeforeCall(grant, now, input.limitMinutes);
    if (left !== null) return { ready: false, reason: 'window_short', minutesLeft: left };
  }
  return { ready: true };
}
