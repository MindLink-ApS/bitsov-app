import type { WatchNotice, WatchRule } from './watches';
import type { AiTopic, TopicRead } from './types';

export type AssistantId = 'node' | 'wallet' | 'inbox';
export const ASSISTANTS: Record<AssistantId, { name: string; role: string; topics: AiTopic[]; suggestions: string[] }> = {
  node: { name: 'Node', role: 'Node health, peers, channels and prices.', topics: ['node', 'channels', 'prices'],
    suggestions: ['How is my node doing?', 'How much inbound liquidity do I have?', 'What do I charge?'] },
  wallet: { name: 'Wallet', role: 'Balance, payment history and prices.', topics: ['balance', 'payments', 'prices'],
    suggestions: ['How much is in my wallet?', 'What did I spend today?', 'What do I charge?'] },
  inbox: { name: 'Inbox', role: 'Inbox counts only. No message bodies.', topics: ['inbox'],
    suggestions: ['Who messaged me?'] },
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
    case 'pay': return `Payment draft to ${p.peer}: ${p.sats} sats`;
    case 'request': return `Request draft to ${p.peer}: ${p.sats} sats\n${p.note}`;
    case 'message': return `Message draft to ${p.recipient}:\n${p.draft_text}`;
  }
}
