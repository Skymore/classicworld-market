import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  root: fileURLToPath(new URL('./desktop/', import.meta.url)),
  base: './', plugins: [react()],
  build: {
    outDir: '../../desktop_ui', emptyOutDir: true, sourcemap: false,
    // The collector window and the grind overlay window.
    rollupOptions: { input: {
      index: fileURLToPath(new URL('./desktop/index.html', import.meta.url)),
      overlay: fileURLToPath(new URL('./desktop/overlay.html', import.meta.url)),
    } },
  },
});
