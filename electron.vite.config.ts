import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { build as viteBuild, type Plugin } from 'vite'
// @ts-expect-error -- a plain .mjs build script without type declarations
import { BUILD_MANIFEST, pinMarker, readPin } from './scripts/job-helper.mjs'
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

const fromRoot = (path: string): string => fileURLToPath(new URL(path, import.meta.url))

/**
 * Builds the sandboxed document worker page (src/main/documents/worker) into
 * out/document-worker, a directory of its own: the worker's session refuses every
 * request outside it. Built after the main bundle, in dev as well as for a release,
 * because the worker is always loaded from files, never from the dev server.
 */
function documentWorkerPlugin(): Plugin {
  const require = createRequire(import.meta.url)
  const pdfiumDir = dirname(dirname(require.resolve('@embedpdf/pdfium')))
  // SheetJS's package exports hide package.json; its LICENSE sits beside the entry point.
  const sheetjsDir = dirname(require.resolve('xlsx'))
  const licenses = [
    [join(pdfiumDir, 'LICENSE'), 'embedpdf-pdfium-LICENSE.txt'],
    [join(pdfiumDir, 'LICENSE.pdfium'), 'pdfium-LICENSE.txt'],
    [join(sheetjsDir, 'LICENSE'), 'sheetjs-LICENSE.txt'],
  ] as const
  return {
    name: 'desktop-agent:document-worker',
    apply: 'build',
    async closeBundle() {
      await viteBuild({
        configFile: false,
        root: fromRoot('./src/main/documents/worker'),
        base: './',
        logLevel: 'warn',
        build: {
          outDir: fromRoot('./out/document-worker'),
          emptyOutDir: true,
          modulePreload: false,
          assetsInlineLimit: 0,
          reportCompressedSize: false,
          rollupOptions: {
            output: {
              entryFileNames: 'assets/[name].js',
              chunkFileNames: 'assets/[name].js',
              assetFileNames: 'assets/[name][extname]',
            },
          },
        },
        plugins: [
          {
            name: 'desktop-agent:document-worker-licenses',
            generateBundle() {
              for (const [file, out] of licenses) {
                this.emitFile({
                  type: 'asset',
                  fileName: `licenses/${out}`,
                  source: readFileSync(file),
                })
              }
            },
          },
        ],
      })
    },
  }
}

/**
 * Writes out/main/.build-manifest.json: every chunk Rollup emitted for main, with the chunks
 * it imports statically and dynamically. afterPack finds the job-run.exe pin by walking it
 * from the production entry (see bundledPin in scripts/job-helper.mjs).
 */
function buildManifestPlugin(): Plugin {
  return {
    name: 'desktop-agent:build-manifest',
    apply: 'build',
    generateBundle(_options, bundle) {
      const chunks = Object.fromEntries(
        Object.values(bundle).flatMap((out) =>
          out.type === 'chunk'
            ? [
                [
                  out.fileName,
                  {
                    name: out.name,
                    isEntry: out.isEntry,
                    // Rollup lists externals (node:fs, electron, ...) here too; keep only chunks.
                    imports: out.imports.filter((file) => file in bundle),
                    dynamicImports: out.dynamicImports.filter((file) => file in bundle),
                  },
                ],
              ]
            : [],
        ),
      )
      this.emitFile({
        type: 'asset',
        fileName: BUILD_MANIFEST as string,
        source: JSON.stringify({ version: 1, chunks }, null, 2),
      })
    },
  }
}

export default defineConfig({
  main: {
    // job-run.exe's digest from `pnpm build:helpers` (Windows) as a unique marker string, or
    // none: see job-launcher.ts.
    define: {
      __JOB_RUN_PIN__: JSON.stringify(
        (pinMarker as (pin: string | null) => string | null)((readPin as () => string | null)()),
      ),
    },
    plugins: [buildManifestPlugin(), documentWorkerPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: fromRoot('./src/main/index.ts'),
          // The document reader on its own, for the real-Electron tests (e2e/document-worker).
          documents: fromRoot('./src/main/documents/index.ts'),
          // The tools with the document reader, for the real-Electron tests (e2e/read-document).
          tools: fromRoot('./src/main/tools/e2e-entry.ts'),
          // The utility process between main and the worker page (see broker.ts).
          'document-broker': fromRoot('./src/main/documents/broker.ts'),
        },
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: {
          index: fromRoot('./src/preload/index.ts'),
          'document-worker': fromRoot('./src/preload/document-worker.ts'),
        },
      },
    },
  },
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
