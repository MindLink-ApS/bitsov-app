import solid from 'vite-plugin-solid';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  cacheDir: '.cache/vitest',
  plugins: [solid()],
  // A fixed build identity for tests (vite.config.ts resolves the real one).
  define: { __APP_COMMIT__: JSON.stringify('0123456789ab'), __APP_VERSION__: JSON.stringify('0.0.1') },
  test: {
    environment: 'happy-dom',
    setupFiles: ['tests/setup.ts'],
    // The pre-M6 app-to-app call tests exercise the WebRTC engine, which M6
    // builds keep but do not reach. Tests of the M6 path stub VITE_CALL_MEDIA.
    env: { VITE_CALL_MEDIA: 'webrtc' },
    include: ['tests/**/*.test.tsx', 'tests/**/*.test.ts'],
  },
});
