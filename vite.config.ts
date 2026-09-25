import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

const root = dirname(fileURLToPath(import.meta.url));

// Tauri desktop dev server. Fixed port so tauri.conf.json devUrl matches.
// `assistant.html` is a second entry for the sealed window. It is not the
// window Tauri shows at startup.
export default defineConfig({
  plugins: [solid()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: {
    rollupOptions: {
      input: {
        main: resolve(root, 'index.html'),
        assistant: resolve(root, 'assistant.html'),
      },
    },
  },
});
