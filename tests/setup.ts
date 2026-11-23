import { beforeEach, vi } from 'vitest';

beforeEach(() => {
  localStorage.clear();
  vi.stubEnv('VITE_CALL_SEAL', '');
});
