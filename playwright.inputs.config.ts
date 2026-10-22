import { defineConfig } from '@playwright/test';

// Headless WebKit only; this checks CSS, not iOS Simulator/WKWebView behavior.
const port = 1422;
export default defineConfig({
  testDir: 'tests/a11y',
  testMatch: 'inputs.spec.ts',
  timeout: 45_000,
  workers: 1,
  reporter: 'line',
  outputDir: 'test-results/inputs',
  use: {
    browserName: 'webkit',
    headless: true,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    reducedMotion: 'reduce',
    baseURL: `http://localhost:${port}`,
  },
  webServer: {
    command: 'npm run dev',
    url: `http://localhost:${port}`,
    reuseExistingServer: false,
    env: { BITSOV_VITE_PORT: String(port) },
  },
});
