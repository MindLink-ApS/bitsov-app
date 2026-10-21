// Test-only fixture; Vite's production entry is index.html, not this page.
import { render } from 'solid-js/web';
import { PhoneOnboarding } from '../../src/onboarding/PhoneOnboarding';
import { INITIAL_PAIRING, type ConnectionError } from '../../src/onboarding/pairing';
import '../../src/styles.css';
const params = new URLSearchParams(location.search);
const state = params.get('state') ?? 'start';
const connected = ['words', 'done', 'fingerprint', 'connecting', 'approval_expired'].includes(state);
const errors = ['unclaimed', 'local_network', 'unreachable', 'busy', 'expired', 'clock', 'used', 'tailscale', 'claim_mismatch', 'other'];
const connection_error = errors.includes(state) ? { kind: state as ConnectionError['kind'], detail: 'Synthetic diagnostic, hidden by default.' } : undefined;
document.documentElement.dataset.theme = params.get('theme') ?? 'dark';
render(() => <PhoneOnboarding locale={params.get('lang') ?? 'en'}
  status={() => ({ ready: connected && state !== 'connecting', node_id: connected ? 'ABCDEF012345' : null, error: null, connection_error })}
  pairing={() => ({ ...INITIAL_PAIRING, remote: connected, state: connected ? 'paired' : 'starting' })}
  device={() => ({ available: true, delegation_supported: state !== 'fingerprint', state: 'none', fingerprint: null, owner_action: null, expires_at_ms: null })}
  scan={async () => { if (state === 'camera') throw { kind: 'camera' }; return new Promise(() => {}); }}
  preview={async () => ({ endpoint: 'test-box', node_id_fingerprint: 'ABCDEF012345' })}
  connect={async () => ({ endpoint: 'test-box', node_id_fingerprint: 'ABCDEF012345', restart_required: false })}
  retry={async () => {}} forget={async () => {}} beginJoin={async () => ({ state: 'idle' })}
  join={async input => input.action === 'cancel' ? { state: 'idle' } : state === 'done' ? { state: 'done' } : ({ state: 'waiting', words: ['abandon', 'ability', 'able', 'about'], expires_at: Date.now()/1000 + (state === 'approval_expired' ? -1 : 300) })}
  openSettings={async () => {}} openTailscale={async () => {}} onDone={() => {}}
/>, document.getElementById('root')!);
