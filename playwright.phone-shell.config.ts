import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'tests/a11y', testMatch: 'phone-shell.spec.ts', workers: 1,
  timeout: 30_000, reporter: 'line', outputDir: 'test-results/phone-shell',
  use: { browserName: 'webkit', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1', viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true,
    contextOptions: { reducedMotion: 'reduce' }, baseURL: 'http://127.0.0.1:1445' },
  webServer: { command: 'npm run dev -- --host 127.0.0.1', url: 'http://127.0.0.1:1445',
    reuseExistingServer: !process.env.CI, env: { BITSOV_VITE_PORT: '1445', VITE_STARTER_BALANCE: '1' } },
});
