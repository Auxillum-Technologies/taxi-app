import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev, the Vite server proxies /api and /ws to the Node API (npm run dev:server).
const API = process.env.API_ORIGIN || 'http://localhost:8787';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': API,
      '/ws': { target: API.replace(/^http/, 'ws'), ws: true },
    },
  },
  // MapLibre loads its worker by URL; pre-bundling breaks that path in dev.
  optimizeDeps: {
    exclude: ['maplibre-gl'],
  },
  build: {
    chunkSizeWarningLimit: 1500, // MapLibre is large by nature
  },
});
