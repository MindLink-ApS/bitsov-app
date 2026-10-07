import type { AiTopic } from './types';

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
export type AssistantThread = { revision: string; turns: AssistantTurn[] };
export type ThreadRequest = { action: 'load' } | { action: 'forget' } | { action: 'append'; revision: string; turn: AssistantTurn };
