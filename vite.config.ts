import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    // Bind the Kubera UI port here (not just the CLI flag) so any launcher — npm, pm2, cmd —
    // serves on 5004 with no args. pm2's --port passthrough is unreliable on Windows.
    port: 5004,
    host: '0.0.0.0',
    hmr: process.env.DISABLE_HMR !== 'true',
  },
});
