import { defineConfig } from 'vite';

// https://v2.tauri.app/start/frontend/vite/
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  build: {
    // WebView2 (Chromium récent) : pas besoin de transpiler pour de vieux navigateurs.
    target: 'chrome105',
    sourcemap: false,
  },
});
