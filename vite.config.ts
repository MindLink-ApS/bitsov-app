import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

const root = dirname(fileURLToPath(import.meta.url));

// `tauri build` sets TAURI_ENV_DEBUG=false for a release bundle. Omit the
// assistant page then so it is not embedded. A plain `npm run build` (the CI
// compile gate) leaves the variable unset and still builds the page.
const includeAssistant = process.env.TAURI_ENV_DEBUG !== 'false';
const input: Record<string, string> = {
  main: resolve(root, 'index.html'),
};
if (includeAssistant) {
  input.assistant = resolve(root, 'assistant.html');
}

// Tauri desktop dev server. Fixed port so tauri.conf.json devUrl matches.
// The assistant entry is not the window Tauri shows at startup.
export default defineConfig({
  plugins: [solid()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: {
    rollupOptions: { input },
  },
});
