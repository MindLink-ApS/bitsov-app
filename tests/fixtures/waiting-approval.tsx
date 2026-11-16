// Local call fixture; no node or native commands are used.
import { render } from 'solid-js/web';
import { ControlCenter } from '../../src/control/Shell';
import { sampleSource } from '../../src/control/sample';
import type { LiveEvent, SpendView } from '../../src/control/types';
import { setLanguagePref } from '../../src/i18n';
import '../../src/styles.css';

const own = '1'.repeat(64), peer = 'a'.repeat(64), primary = 'e'.repeat(32), waiting = 'f'.repeat(32);
setLanguagePref(new URLSearchParams(location.search).get('lang') === 'da' ? 'da' : 'en');
document.documentElement.dataset.platform = 'ios';
const sample = sampleSource();
let emit: (event: LiveEvent) => void;
let spend: SpendView = { state: 'locked', basis: null, open_until_ms: null, pending: null, window_ms: 600_000 };
const source = {
  ...sample,
  messages: async () => [],
  spendStatus: async () => spend,
  spendRequest: async () => (spend = { ...spend, state: 'open', open_until_ms: Date.now() + 600_000 }),
  budgetStatus: async () => ({ ...await sample.budgetStatus(), paused: false, waiting_for_owner: false,
    autopay: { state: 'off' as const, open_until_ms: null, ceiling_msat: null, basis: null } }),
  onLive: async (handler: (event: LiveEvent) => void) => { emit = handler; return () => {}; },
  liveLink: async () => 'open' as const,
};
const message = (kind: number, id: string) => emit({ type: 'message', room_id: null, message: {
  id: `${id}-${kind}`, kind, sender: peer, recipient: own, timestamp: Date.now(), payment_amount_msat: 1000,
  plaintext: JSON.stringify({ v: 1, call_id: id, media: 'audio', sdp: 'v=0', reason: 'hangup' }),
} });
render(() => <>
  <button data-fixture-ring onClick={() => { message(400, primary); message(400, waiting); }}>Ring twice</button>
  <button data-fixture-end onClick={() => message(403, primary)}>End primary</button>
  <ControlCenter source={source} active ready ownId={own} error={null} firstRun={null} />
</>, document.getElementById('root')!);
