import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    host: true,
    proxy: {
      '/api/genlayer': {
        target: 'https://studio.genlayer.com',
        changeOrigin: true,
        rewrite: () => '/api',
      },
    },
  },
});
