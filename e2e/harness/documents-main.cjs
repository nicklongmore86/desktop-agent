// An Electron main for the document reader's real-window tests: the built
// DocumentWorkerHost (out/main/documents.js) with its sandboxed worker page
// (out/document-worker) and preload, exactly as the app ships them. The test drives
// it through `electronApp.evaluate` and `globalThis.documents`. Run `pnpm build` first.
const { app, nativeImage } = require('electron')
const { join } = require('node:path')
const { DocumentWorkerHost, documentWorkerPaths } = require('../../out/main/documents.js')

// No app.enableSandbox() here (it overrides --no-sandbox, which Linux CI containers need);
// the worker window asks for sandbox: true itself.

const { cpSync, mkdtempSync } = require('node:fs')
const { tmpdir } = require('node:os')

const { hostile, ...options } = JSON.parse(process.env.E2E_DOCUMENT_HOST ?? '{}')
const paths = documentWorkerPaths(join(__dirname, '../../out/main'))
if (hostile) {
  // A copy of the built worker whose script is replaced by a hostile one.
  const dir = join(mkdtempSync(join(tmpdir(), 'hostile-worker-')), 'document-worker')
  cpSync(paths.workerDir, dir, { recursive: true })
  cpSync(join(__dirname, 'hostile-worker.js'), join(dir, 'assets', 'index.js'))
  paths.workerDir = dir
}

// Counts main's event-loop turns, so a test can tell whether main ever stalled.
let ticks = 0
setInterval(() => {
  ticks++
}, 10)

/** A view with its image bytes as base64, plus a few decoded pixels to check orientation. */
function serialise(view) {
  return {
    ...view,
    images: view.images.map((image) => {
      const decoded = nativeImage.createFromBuffer(Buffer.from(image.bytes))
      const size = decoded.getSize()
      const bitmap = decoded.toBitmap()
      // BGRA; sample the centre of the top and bottom quarters.
      const pixel = (x, y) => {
        const at = (Math.floor(y) * size.width + Math.floor(x)) * 4
        return { r: bitmap[at + 2], g: bitmap[at + 1], b: bitmap[at] }
      }
      return {
        ...image,
        bytes: Buffer.from(image.bytes).toString('base64'),
        decodedSize: size,
        top: pixel(size.width / 2, size.height / 4),
        bottom: pixel(size.width / 2, (size.height * 3) / 4),
      }
    }),
  }
}

app.whenReady().then(() => {
  const host = new DocumentWorkerHost({ ...paths, ...options })
  globalThis.documents = {
    extract: (base64, extractOptions) =>
      host.extract(Buffer.from(base64, 'base64'), extractOptions).then(serialise, (error) => ({
        error: { name: error.name, code: error.code, message: error.message },
      })),
    stats: () => host.stats(),
    ticks: () => ticks,
    /** Live broker processes and worker windows. */
    alive: () => ({
      brokers: app
        .getAppMetrics()
        .filter((metric) => metric.type === 'Utility' && metric.name === 'Document reader broker')
        .length,
      windows: require('electron').BrowserWindow.getAllWindows().length,
    }),
    /** A PNG of random noise: as hard to compress as an image gets. */
    makeNoise: (width, height) => {
      const pixels = require('node:crypto').randomBytes(width * height * 4)
      for (let at = 3; at < pixels.length; at += 4) pixels[at] = 255
      return nativeImage.createFromBitmap(pixels, { width, height }).toPNG().toString('base64')
    },
    /** A JPEG, left half red and right half blue, encoded by Chromium. */
    makeJpeg: (width, height) => {
      const pixels = Buffer.alloc(width * height * 4)
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const at = (y * width + x) * 4
          const left = x < width / 2
          pixels[at] = left ? 0 : 255 // B
          pixels[at + 1] = 0 // G
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
