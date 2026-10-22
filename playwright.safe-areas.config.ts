import { defineConfig } from '@playwright/test';

// Desktop WebKit has no device env() insets; the specs inject measured values.
// No simulator or native app is started. Evidence stays in the ignored directory.
const port = 1423;
export default defineConfig({
  testDir: 'tests/a11y',
  testMatch: 'safe-areas*.spec.ts',
  timeout: 45_000,
  workers: 1,
  reporter: 'line',
  outputDir: 'test-results/safe-areas-webkit',
  use: {
    browserName: 'webkit',
    headless: true,
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
