import { t as tr } from '../i18n';
import type { WatchNotice, WatchRule } from './watches';
import type { AiTopic, TopicRead } from './types';

export type AssistantId = 'node' | 'wallet' | 'inbox';
export const ASSISTANTS: Record<AssistantId, { name: string; role: string; topics: AiTopic[]; suggestions: string[] }> = {
  node: { get name() { return tr('uiNode'); }, get role() { return tr('caNodeHealthPeersChannelsAndPrices'); }, topics: ['node', 'channels', 'prices'],
    get suggestions() { return [tr('caHowIsMyNodeDoing'), tr('caHowMuchInboundLiquidityDoIHave'), tr('caWhatDoICharge')]; } },
  wallet: { get name() { return tr('uiWallet'); }, get role() { return tr('caBalancePaymentHistoryAndPrices'); }, topics: ['balance', 'payments', 'prices'],
    get suggestions() { return [tr('caHowMuchIsInMyWallet'), tr('caWhatDidISpendToday'), tr('caWhatDoICharge')]; } },
  inbox: { get name() { return tr('caInbox'); }, get role() { return tr('caInboxCountsOnlyNoMessageBodies'); }, topics: ['inbox'],
    get suggestions() { return [tr('caWhoMessagedMe')]; } },
};
export type AssistantTurn = { at: number; question: string; answer: string };
export type AssistantThread = { revision: string; turns: AssistantTurn[]; notices?: WatchNotice[]; disabled_watches?: WatchRule[] };
export type ThreadRequest = { action: 'load' } | { action: 'forget' } | { action: 'set_watch'; rule: WatchRule; enabled: boolean } | { action: 'append'; revision: string; turn: AssistantTurn };

/** Host-validated model data. Never accepted by the action/composer dispatcher. */
export type ModelProposal =
  | { kind: 'pay'; peer: string; sats: number }
  | { kind: 'request'; peer: string; sats: number; note: string }
  | { kind: 'message'; recipient: string; draft_text: string };
export type LocalTurn = {
  output: { kind: 'answer'; text: string; topics: AiTopic[] } | { kind: 'proposal'; proposal: ModelProposal };
  reads: TopicRead[];
};
export function modelProposalText(p: ModelProposal): string {
  switch (p.kind) {
    case 'pay': return tr('caPaymentDraftToSats', p.peer, p.sats);
    case 'request': return tr('caRequestDraftToSats', p.peer, p.sats, p.note);
    case 'message': return tr('caMessageDraftTo', p.recipient, p.draft_text);
  }
}
