// Checks what went into app.asar: the test-only bundles (built for the real-Electron tests,
// see electron.vite.config.ts) must not ship in the installer.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Files electron-builder.yml excludes from the package; their presence fails the build. */
export const TEST_ONLY = ['out/main/tools.js']

/** Every file path in an asar archive, '/'-separated, from its JSON header. */
export async function listAsar(file) {
  const bytes = await readFile(file)
  // A Chromium pickle: [4][header pickle size][4 + string length][string length][JSON].
  const length = bytes.readUInt32LE(12)
  const header = JSON.parse(bytes.subarray(16, 16 + length).toString('utf8'))
  const paths = []
  const walk = (node, prefix) => {
    for (const [name, child] of Object.entries(node.files ?? {})) {
      const at = prefix ? `${prefix}/${name}` : name
      if (child.files) walk(child, at)
      else paths.push(at)
    }
  }
  walk(header, '')
  return paths
}

export async function verifyAppFiles(resources) {
  const files = new Set(await listAsar(join(resources, 'app.asar')))
  if (!files.has('out/main/index.js')) {
    throw new Error('app.asar has no out/main/index.js; is the archive readable?')
  }
  const shipped = TEST_ONLY.filter((file) => files.has(file))
  if (shipped.length) {
    throw new Error(`Test-only files are in app.asar: ${shipped.join(', ')}`)
  }
  console.log(`app.asar: ${String(files.size)} files, no test-only bundles`)
}
