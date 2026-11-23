import { render } from 'solid-js/web';
import { afterEach, expect, it } from 'vitest';
import { setLanguagePref } from '../src/i18n';
import { SoftError } from '../src/control/SoftError';
import { asActionError } from '../src/control/state';

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); document.body.innerHTML = ''; setLanguagePref('en'); });

// As a card read shows it: only the message reaches the alert, not the error's code.
function shown(error: { code: string; message: string }, summary?: string) {
  setLanguagePref('da');
  const message = asActionError(error).message;
  dispose = render(() => <SoftError message={message} data="porch-error" summary={summary} />, document.body);
  const alert = document.querySelector<HTMLElement>('[data-soft-summary]')!;
  return { alert: alert.textContent ?? '', details: document.querySelector('details'), reconnect: document.body.textContent };
}

it.each([
  ['paid beyond the ceiling', 'Outcome unknown; another spend is blocked until reconciled. The node reports 500 msat paid, beyond the confirmed ceiling (400). Funds may already have moved; do not retry.', /Funds may already have moved; do not retry/],
  ['with a plain next step', 'Outcome unknown; another spend is blocked until reconciled. Check the pending result before sending again.', /Check the pending result before sending again/],
])('a wrapped payment warning stays in the alert in Danish, not behind Details: %s', (_name, message, words) => {
  const { alert, details } = shown({ code: 'spend_unknown', message });
  expect(alert).toMatch(/^Udfaldet er ukendt/);
  expect(alert).toMatch(words);
  expect(alert).not.toContain('Det kunne ikke gennemføres');
  expect(details).toBeNull();
});

it('a general summary cannot replace it either', () => {
  const { alert } = shown({ code: 'spend_unknown', message: 'Outcome unknown; another spend is blocked until reconciled. The node reports 500 msat paid, beyond the confirmed ceiling (400). Funds may already have moved; do not retry.' }, 'Noget gik galt');
  expect(alert).not.toContain('Noget gik galt');
  expect(alert).toMatch(/^Udfaldet er ukendt/);
});

it('a fully Danish money refusal stays in the alert too', () => {
  const { alert, details } = shown({ code: 'node', message: 'The node reports 500 msat paid, beyond the confirmed ceiling (400). Funds may already have moved; do not retry.' });
  expect(alert).toContain('Penge kan allerede være betalt; prøv ikke igen.');
  expect(details).toBeNull();
});
