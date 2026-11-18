import { defineConfig } from '@playwright/test';

// Local only. Not wired into GitHub Actions.
// Uses the installed Google Chrome so the check does not download a browser.
const port = 1421;

export default defineConfig({
  testDir: 'tests/a11y',
  testIgnore: 'inputs.spec.ts', // Dedicated WebKit run: playwright.inputs.config.ts.
  timeout: 45_000,
  fullyParallel: false,
  retries: 0,
  reporter: 'line',
  use: {
    baseURL: `http://localhost:${port}`,
    channel: 'chrome',
    viewport: { width: 1280, height: 820 },
    // Settled colours. A mid-transition opacity makes axe report blended greys.
    contextOptions: { reducedMotion: 'reduce' },
  },
  webServer: {
    command: 'npm run dev',
    url: `http://localhost:${port}`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: { BITSOV_VITE_PORT: String(port) },
  },
});
