// Local test fixture, excluded from the production entry.
import { render } from 'solid-js/web';
import { WalletPage } from '../../src/control/WalletPage';
import type { StarterStatus } from '../../src/control/starter';
import { setLanguagePref } from '../../src/i18n';
import '../../src/styles.css';

const params = new URLSearchParams(location.search);
setLanguagePref(params.get('lang') === 'da' ? 'da' : 'en');
document.documentElement.lang = params.get('lang') === 'da' ? 'da' : 'en';
document.documentElement.dataset.theme = params.get('theme') ?? 'dark';
let status: StarterStatus = params.get('state') === 'ready'
  ? { state: 'ready', verified: true, hub_configured: true, push_sats: 10000 }
  : { state: 'not_requested', hub_configured: true, hub_alias: 'Signet hub' };
const unused = async (): Promise<never> => { throw new Error('Unexpected wallet action'); };
render(() => <WalletPage tab="activity" onTab={() => {}} onClose={() => {}}
  wallet={{ balance_msat: 0, lightning_outbound_msat: 0, channels: [] }} moneyBlocked={false} spend={null} spendGate={null}
  now={Date.now()} ownId="fixture-node" histories={[]} threadMessages={[]} nameOf={id => id}
  actions={{ readInvoice: unused, pay: unused, keysend: unused, invoice: unused, approve: unused }}
  reads={{ messages: async () => [], fundingAddress: unused, invoiceStatus: unused }} onRefresh={() => {}}
  starter={{ enabled: true, network: 'signet', nodeId: 'fixture-node', capabilities: ['starter_channel_request_v1'],
    api: { current: async () => status, request: async request_id => (status = { ...status, state: 'requested', request_id }) } }}
/>, document.getElementById('root')!);
