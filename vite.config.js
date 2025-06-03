import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: '/kafka-visualiser/',
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
  }
})
