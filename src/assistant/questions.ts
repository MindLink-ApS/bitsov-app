import { t } from '../i18n';
import type { assistantQuestionsEn } from '../assistantQuestionsCopy';
import fixture from '../../jarvis/fixtures/questions.json';
import type { RouteKey } from './source';

/** A fixture question as the window shows it. No expected values. */
export type Question = { id: string; text: string; route: RouteKey | null };

/**
 * The node route a fixture `sources` path is read from. `peers` (q32, q43)
 * is not a broker route: those rows are always `Unavailable`.
 */
function routeOf(source: string): RouteKey | null {
  if (source.startsWith('channels')) return 'channels';
  if (source.startsWith('payments.balance')) return 'balance';
  if (source.startsWith('payments.price') || source.startsWith('pricing')) return 'pricing';
  if (source.startsWith('health') || source.startsWith('status')) return 'health';
  if (source.startsWith('messages')) return 'messages';
  return null;
}

/** Compiled in from the pinned fixture. Only id, text and route are kept. */
export const QUESTIONS: readonly Question[] = fixture.questions.map((q) => ({
  id: q.id,
  get text() { return t(`assistantQuestion${q.id}` as keyof typeof assistantQuestionsEn); },
  route: routeOf(q.sources[0] ?? ''),
}));

export function questionFor(id: string): Question | undefined {
  return QUESTIONS.find((question) => question.id === id);
}
