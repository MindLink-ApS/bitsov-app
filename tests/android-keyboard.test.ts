import { afterEach, expect, it, vi } from 'vitest';
import { installAndroidKeyboardVisibility } from '../src/control/PhoneShell';
afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = ''; delete document.documentElement.dataset.keyboardOpen; });
it('hides phone tabs for an Android keyboard that resizes the layout viewport and restores them on dismissal', () => {
  let height = 852;
  vi.spyOn(window, 'innerHeight', 'get').mockImplementation(() => height);
  const stop = installAndroidKeyboardVisibility();
  const input = document.createElement('textarea'); document.body.append(input); input.focus();
  height = 500; window.dispatchEvent(new Event('resize'));
  expect(document.documentElement.dataset.keyboardOpen).toBe('true');
  height = 852; window.dispatchEvent(new Event('resize'));
  expect(document.documentElement.dataset.keyboardOpen).toBe('false');
  stop();
});
it('does not hide tabs for ordinary resizing without a focused field', () => {
  let height = 852; vi.spyOn(window, 'innerHeight', 'get').mockImplementation(() => height);
  const stop = installAndroidKeyboardVisibility(); height = 500; window.dispatchEvent(new Event('resize'));
  expect(document.documentElement.dataset.keyboardOpen).toBe('false'); stop();
});
it('keeps tabs hidden while focus moves between fields with the keyboard still up', () => {
  let height = 852; vi.spyOn(window, 'innerHeight', 'get').mockImplementation(() => height);
  const stop = installAndroidKeyboardVisibility();
  const one = document.createElement('input'), two = document.createElement('input'); document.body.append(one, two);
  one.focus(); height = 500; window.dispatchEvent(new Event('resize'));
  one.blur(); two.focus();
  expect(document.documentElement.dataset.keyboardOpen).toBe('true');
  height = 852; window.dispatchEvent(new Event('resize'));
  expect(document.documentElement.dataset.keyboardOpen).toBe('false'); stop();
});
