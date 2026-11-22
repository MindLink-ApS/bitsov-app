import { defineConfig } from '@playwright/test';
// Complementary regression coverage. Native OS-size evidence is capture.py.
export default defineConfig({
  testDir: 'tests/a11y', testMatch: 'dynamic-type.spec.ts', workers: 1,
  timeout: 45_000, reporter: 'line', outputDir: 'test-results/dynamic-type',
  use: { browserName: 'webkit', viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true,
    contextOptions: { reducedMotion: 'reduce' }, baseURL: 'http://127.0.0.1:1438' },
  webServer: { command: 'npm run dev -- --host 127.0.0.1', url: 'http://127.0.0.1:1438',
    reuseExistingServer: !process.env.CI, env: { BITSOV_VITE_PORT: '1438' } },
});
