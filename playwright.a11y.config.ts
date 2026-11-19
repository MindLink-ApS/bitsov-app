import { defineConfig } from '@playwright/test';

// Local only. Not wired into GitHub Actions.
// Uses the installed Google Chrome so the check does not download a browser.
//
// Three projects, each with its own dev server so a build flag reaches only
// the tests that need it:
// - desktop: every spec except the phone shell, with the default product flags.
// - phone: the phone shell on a handset profile. The app decides "phone" from
//   the user agent and touch points, so a narrow viewport alone is not enough.
//   Same fixture contract as playwright.phone-shell.config.ts, starter flag included.
// - legacy-media: the meeting planner checks, which need the pre-M6 call UI
//   (as in playwright.safe-areas.config.ts). The product default stays node media.
// - call-media-webrtc: whole specs that drive the pre-M6 call UI in the real app
//   (the call button needs the WebRTC build). Listed once in `webrtcCallSpecs`,
//   kept out of desktop, and run on the legacy-media server with a handset
//   profile and a fake microphone, as in playwright.webkit.config.ts. Specs
//   override per describe.
const desktopPort = 1421;
const phonePort = 1446;
const legacyMediaPort = 1447;

const planner = /12-contact planner and primary actions remain reachable/;
// Specs that need VITE_CALL_MEDIA=webrtc for every case.
const webrtcCallSpecs = ['call-panel-composer.spec.ts'];

const server = (port: number, env: Record<string, string> = {}) => ({
  command: 'npm run dev',
  url: `http://localhost:${port}`,
  reuseExistingServer: false,
  timeout: 30_000,
  env: { BITSOV_VITE_PORT: String(port), ...env },
});

export default defineConfig({
  testDir: 'tests/a11y',
  timeout: 45_000,
  fullyParallel: false,
  retries: 0,
  reporter: 'line',
  use: {
    channel: 'chrome',
    // Settled colours. A mid-transition opacity makes axe report blended greys.
    reducedMotion: 'reduce',
  },
  projects: [
    {
      name: 'desktop',
      // inputs.spec.ts has a dedicated WebKit run: playwright.inputs.config.ts.
      testIgnore: ['inputs.spec.ts', 'phone-shell.spec.ts', ...webrtcCallSpecs],
      grepInvert: planner,
      use: {
        baseURL: `http://localhost:${desktopPort}`,
        viewport: { width: 1280, height: 820 },
      },
    },
    {
      name: 'phone',
      testMatch: 'phone-shell.spec.ts',
      use: {
        baseURL: `http://localhost:${phonePort}`,
        userAgent:
          'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
        viewport: { width: 393, height: 852 },
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: 'legacy-media',
      testMatch: 'safe-areas-followups.spec.ts',
      grep: planner,
      use: {
        baseURL: `http://localhost:${legacyMediaPort}`,
        viewport: { width: 1280, height: 820 },
      },
    },
    {
      name: 'call-media-webrtc',
      testMatch: webrtcCallSpecs,
      use: {
        baseURL: `http://localhost:${legacyMediaPort}`,
        viewport: { width: 393, height: 852 },
        isMobile: true,
        hasTouch: true,
        // Placing a call asks for the microphone. Headless Chrome refuses it,
        // which ends the call before the card can be measured; give it a fake one.
        permissions: ['microphone', 'camera'],
        launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] },
      },
    },
  ],
  webServer: [
    server(desktopPort),
    server(phonePort, { VITE_STARTER_BALANCE: '1' }),
    server(legacyMediaPort, { VITE_CALL_MEDIA: 'webrtc' }),
  ],
});
