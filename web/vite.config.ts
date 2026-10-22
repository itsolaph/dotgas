import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Env files are read from the repo root so web + relayer share one `.env`.
export default defineConfig({
  plugins: [react()],
  envDir: '..',
  server: { port: 5173 },
  build: { chunkSizeWarningLimit: 700 },
});
