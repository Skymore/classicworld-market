import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  root: fileURLToPath(new URL('./desktop/', import.meta.url)),
  base: './', plugins: [react()],
  build: { outDir: '../../desktop_ui', emptyOutDir: true, sourcemap: false },
});
