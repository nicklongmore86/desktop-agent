import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'
import { buildCsp } from './src/shared/csp'

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
  main: {},
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
          replacement: fileURLToPath(
            new URL('./node_modules/lowlight/lib/index.js', import.meta.url),
          ),
        },
      ],
    },
  },
})
