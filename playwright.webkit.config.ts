import { defineConfig } from '@playwright/test';

// One server/browser install for every WebKit suite on main. Keyboard coverage
// (including legacy fallback) lives in dynamic-type.spec.ts.
const port = 1423;
export default defineConfig({
  testDir: 'tests/a11y',
  testMatch: ['safe-areas*.spec.ts', 'dynamic-type.spec.ts', 'inputs.spec.ts', 'chain-warnings.spec.ts', 'call-self-tile.spec.ts'],
  projects: [
    { name: 'webkit' },
    {
      name: 'phone-shell',
      testMatch: 'phone-shell.spec.ts',
      use: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1' },
    },
  ],
  forbidOnly: !!process.env.CI,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  reporter: 'line',
  outputDir: 'test-results/webkit',
  use: {
    browserName: 'webkit',
    headless: true,
    viewport: { width: 393, height: 852 },
    isMobile: true,
    hasTouch: true,
    reducedMotion: 'reduce',
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1',
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    // These a11y specs exercise the pre-M6 app-to-app call UI (video, meetings),
    // which M6 builds hide; run the dev server in the kept lab profile.
    env: { BITSOV_VITE_PORT: String(port), VITE_CALL_MEDIA: 'webrtc', VITE_STARTER_BALANCE: '1' },
  },
});
