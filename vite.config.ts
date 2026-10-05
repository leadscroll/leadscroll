import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  // Stamps the SPA bundle with the instance build time; the sidebar shows it as
  // the release label until LeadScroll publishes named releases.
  define: {
    LEADSCROLL_BUILD_DATE: JSON.stringify(new Date().toISOString()),
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('src', import.meta.url)),
    },
  },
});
