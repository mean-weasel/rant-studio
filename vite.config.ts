import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: 'rant-studio.localhost',
    port: 4173,
    strictPort: true,
  },
});
