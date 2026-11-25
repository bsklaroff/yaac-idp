import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    projects: [
      { extends: true, test: { name: 'server', environment: 'node', include: ['test/server/**/*.test.ts'] } },
      { extends: true, test: { name: 'web', environment: 'jsdom', include: ['test/web/**/*.test.tsx'] } },
    ],
  },
})
