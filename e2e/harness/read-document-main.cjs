// An Electron main for read_document's real-window tests: the agent's tools (built on
// their own as out/main/tools.js) over the real DocumentWorkerHost and its sandboxed
// worker, exactly as the app wires them. The test drives it through
// `electronApp.evaluate` and `globalThis.reader`. Run `pnpm build` first.
const { app, nativeImage } = require('electron')
const { cpSync, mkdtempSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const {
  createTools,
  DocumentTextCache,
  DocumentWorkerHost,
  documentWorkerPaths,
  PathGuard,
} = require('../../out/main/tools.js')

// No app.enableSandbox() here (it overrides --no-sandbox, which Linux CI containers need);
// the worker window asks for sandbox: true itself.

const { hostile, ...options } = JSON.parse(process.env.E2E_DOCUMENT_HOST ?? '{}')
const paths = documentWorkerPaths(join(__dirname, '../../out/main'))
if (hostile) {
  // A copy of the built worker whose script is replaced by a hostile one.
  const dir = join(mkdtempSync(join(tmpdir(), 'hostile-worker-')), 'document-worker')
  cpSync(paths.workerDir, dir, { recursive: true })
  cpSync(join(__dirname, 'hostile-worker.js'), join(dir, 'assets', 'index.js'))
  paths.workerDir = dir
}

app.whenReady().then(() => {
  const host = new DocumentWorkerHost({ ...paths, ...options })
  const entries = []
  let tools = []
  const audit = {
    record: (entry) => {
      entries.push(entry)
      return Promise.resolve()
    },
  }
  const tool = (name) => tools.find((t) => t.name === name)
  const ctx = () => ({
    signal: new AbortController().signal,
    requestApproval: () => Promise.resolve(false),
  })
  globalThis.reader = {
    /**
     * Grants `root` (only), with `blocked` as the app's protected paths, and keeps
     * search_files' document text in `cacheDir` when one is given.
     */
    grant: (root, blocked = [], cacheDir) => {
      tools = createTools({
        guard: new PathGuard({ roots: () => [root], protectedPaths: blocked }),
        audit,
        trash: () => Promise.reject(new Error('not in this harness')),
        documents: host,
        ...(cacheDir
          ? {
              documentCache: new DocumentTextCache({
                dir: cacheDir,
                grants: { list: () => [root], token: (r) => (r === root ? 'grant' : null) },
              }),
            }
          : {}),
      })
    },
    /** A tool's result, with each image's bytes as base64 and its decoded size. */
    run: async (name, input) => {
      const result = await tool(name).execute(input, ctx())
      return {
        ...result,
        images: result.images?.map((image) => ({
          ...image,
          data: Buffer.from(image.data).toString('base64'),
          decodedSize: nativeImage.createFromBuffer(Buffer.from(image.data)).getSize(),
        })),
      }
    },
    audit: () => entries,
    /** A JPEG, left half red and right half blue, encoded by Chromium. */
    makeJpeg: (width, height) => {
      const pixels = Buffer.alloc(width * height * 4)
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const at = (y * width + x) * 4
          const left = x < width / 2
          pixels[at] = left ? 0 : 255 // B
          pixels[at + 2] = left ? 255 : 0 // R
          pixels[at + 3] = 255
        }
      }
      return nativeImage.createFromBitmap(pixels, { width, height }).toJPEG(92).toString('base64')
    },
  }
})

// Destroying a worker window must not quit the app.
app.on('window-all-closed', () => undefined)
