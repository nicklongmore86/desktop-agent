import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'
// @ts-expect-error -- a plain .mjs build script without type declarations
import { readPin } from './scripts/job-helper.mjs'
import { buildCsp } from './src/shared/csp'

// lowlight's package `exports` hides lib/, so resolve its entry point and step to lib/ beside it.
const lowlightLib = join(
  dirname(createRequire(import.meta.url).resolve('lowlight')),
  'lib',
  'index.js',
)

/** Injects the renderer's Content-Security-Policy, relaxed only for the dev server. */
function cspPlugin(): Plugin {
  let dev = false
  return {
    name: 'desktop-agent:csp',
    configResolved(config) {
      dev = config.command === 'serve'
    },
    transformIndexHtml() {
      return [
        {
          tag: 'meta',
          attrs: { 'http-equiv': 'Content-Security-Policy', content: buildCsp({ dev }) },
          injectTo: 'head-prepend',
        },
      ]
    },
  }
}

export default defineConfig({
  main: {
    // job-run.exe's digest from `pnpm build:helpers` (Windows), or none: see job-launcher.ts.
    define: { __JOB_RUN_SHA256__: JSON.stringify((readPin as () => string | null)()) },
  },
  preload: {},
  renderer: {
    plugins: [react(), cspPlugin()],
    resolve: {
      alias: [
        // Keep lowlight's 37-language default set out of the bundle (see the shim).
        {
          find: /^lowlight$/,
          replacement: fileURLToPath(new URL('./src/renderer/lowlight-slim.mjs', import.meta.url)),
        },
        {
          find: 'lowlight-lib',
          replacement: lowlightLib,
        },
      ],
    },
  },
})
