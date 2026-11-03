import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { MONEY_NOT_READY } from '../src/control/readiness';
import { copy } from '../src/i18n';

// The UI matches the host's readiness refusal by its exact text; both sides must say the same thing.
it('keeps the host MONEY_NOT_READY and the client constant identical', () => {
  const host = readFileSync('src-tauri/src/act.rs', 'utf8').match(/pub const MONEY_NOT_READY: &str = "([^"]*)";/);
  expect(host?.[1]).toBe(MONEY_NOT_READY);
  expect(MONEY_NOT_READY).toBe(copy.en.moneyNotReady);
  expect(MONEY_NOT_READY).not.toMatch(/\bnode\b/i);
});
