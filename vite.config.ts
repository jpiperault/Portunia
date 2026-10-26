import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// https://v2.tauri.app/start/frontend/vite/
export default defineConfig({
  clearScreen: false,
  // Version affichée dans la barre d'état.
  define: { __APP_VERSION__: JSON.stringify(version) },
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
