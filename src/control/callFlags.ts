/**
 * Call media path for this build (M6 line A1).
 *
 * Owner decision (M6): the node is the cell. Call audio goes app -> own node
 * -> peer node -> peer app over the node's owner-scoped media socket, which
 * the Rust host owns. Direct app-to-app WebRTC media is OFF in M6 builds and
 * is never the call path; its code stays in the tree, unreachable while this
 * flag says `node`.
 *
 * The value is fixed at build time by vite.config.ts from `VITE_CALL_MEDIA`
 * (shared with the parent build process, like `VITE_STARTER_BALANCE`). Only
 * the exact value `webrtc` selects the pre-M6 lab path; everything else,
 * including an unset variable, is the M6 profile.
 */
export type CallMediaPath = 'node' | 'webrtc';

export type CallMediaEnv = { VITE_CALL_MEDIA?: string; VITE_CALL_SEAL?: string };

export function callMediaPath(env: CallMediaEnv = import.meta.env as CallMediaEnv): CallMediaPath {
  return env.VITE_CALL_MEDIA === 'webrtc' ? 'webrtc' : 'node';
}

/** Node-routed audio is the call path; app-to-app media, video and meetings are off. */
export const nodeRoutedAudio = (env?: CallMediaEnv) => callMediaPath(env) === 'node';

/**
 * App-to-app sealing of node-routed audio, off by default: only the exact
 * value `sealed` turns it on, and only on the node-routed path. With it off
 * a call sends the same bytes as a build without the code.
 */
export const sealedAudio = (env: CallMediaEnv = import.meta.env as CallMediaEnv) =>
  callMediaPath(env) === 'node' && env.VITE_CALL_SEAL === 'sealed';
