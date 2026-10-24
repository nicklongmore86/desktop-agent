import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'main',
          include: [
            'src/main/**/*.test.ts',
            'src/preload/**/*.test.ts',
            'src/shared/**/*.test.ts',
            'scripts/**/*.test.mjs',
          ],
          environment: 'node',
        },
      },
      {
        plugins: [react()],
        test: {
          name: 'renderer',
          include: ['src/renderer/**/*.test.{ts,tsx}'],
          environment: 'jsdom',
          // Let tests read the real stylesheet (e.g. the untrusted-text rules).
          css: { include: [/styles\/.*\.css/] },
          setupFiles: ['src/renderer/src/test/setup.ts'],
        },
      },
    ],
  },
})
