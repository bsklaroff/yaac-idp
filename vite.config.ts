import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Two pages: the sign-in page the public listener serves and the admin page
 * the admin listener serves. `pnpm dev:web` proxies each page's API to a
 * locally running issuer whose IDP_PUBLIC_URL is this dev server's origin.
 */
export default defineConfig({
  root: 'src/web',
  plugins: [react()],
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist/web'),
    emptyOutDir: true,
    rollupOptions: {
      input: ['src/web/index.html', 'src/web/admin.html'].map((file) => path.resolve(import.meta.dirname, file)),
    },
  },
  server: {
    proxy: {
      '/api/auth': 'http://localhost:3000',
      '/.well-known': 'http://localhost:3000',
      '/api': 'http://localhost:3001',
    },
  },
})
