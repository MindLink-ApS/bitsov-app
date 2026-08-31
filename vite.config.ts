import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

// Tauri desktop dev server. Fixed port so tauri.conf.json devUrl matches.
export default defineConfig({
  plugins: [solid()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
});
