// job-run.exe (native/job-run): the build's pins file and the checks shared by
// build-job-helper.mjs, the Vite build (which compiles the digest into the app) and afterPack.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const JOB_RUN_VERSION = '1.0.0.0'
export const repoRoot = fileURLToPath(new URL('..', import.meta.url))
/** The built launcher; electron-builder copies build/helpers to resources/helpers. */
export const helperFile = join(repoRoot, 'build', 'helpers', 'job-run.exe')
/** Written next to (not inside) build/helpers, so it is not packaged. */
export const pinsFile = join(repoRoot, 'build', 'job-helper-pins.json')
export const PINNED_PATH = 'helpers/job-run.exe'

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

/** The pinned digest of this build's launcher, or null if it was not built. */
export function readPin() {
  if (!existsSync(pinsFile)) return null
  const hash = JSON.parse(readFileSync(pinsFile, 'utf8'))[PINNED_PATH]?.sha256
  if (!/^[0-9a-f]{64}$/.test(hash ?? '')) throw new Error(`Invalid pin in ${pinsFile}`)
  return hash
}

const PE_FLAGS = {
  HIGH_ENTROPY_VA: 0x0020,
  DYNAMIC_BASE: 0x0040,
  NX_COMPAT: 0x0100,
  GUARD_CF: 0x4000,
}

/** Fails unless `bytes` is an x64 console PE with ASLR, DEP and Control Flow Guard. */
export function checkHardening(bytes) {
  const pe = bytes.readUInt32LE(0x3c)
  if (bytes.toString('latin1', 0, 2) !== 'MZ' || bytes.readUInt32LE(pe) !== 0x4550)
    throw new Error('job-run.exe is not a PE file')
  if (bytes.readUInt16LE(pe + 4) !== 0x8664) throw new Error('job-run.exe is not x64')
  const optional = pe + 24
  if (bytes.readUInt16LE(optional) !== 0x20b) throw new Error('job-run.exe is not PE32+')
  if (bytes.readUInt16LE(optional + 68) !== 3) throw new Error('job-run.exe is not a console app')
  const flags = bytes.readUInt16LE(optional + 70)
  const missing = Object.entries(PE_FLAGS).filter(([, bit]) => (flags & bit) === 0)
  if (missing.length)
    throw new Error(`job-run.exe lacks ${missing.map(([name]) => name).join(', ')}`)
}

/** Main entries built only for the real-Electron tests (electron.vite.config.ts). */
const TEST_ENTRIES = ['tools.js', 'documents.js']
/** Written into out/main by the main build: its chunks and their imports, from Rollup. */
export const BUILD_MANIFEST = '.build-manifest.json'
/** The string the main build compiles in for job-launcher.ts's JOB_RUN_SHA256. */
const MARKER_PREFIX = 'job-run.exe-sha256:'
export const pinMarker = (pin) => (pin ? `${MARKER_PREFIX}${pin}` : null)
const DIGEST = /^[0-9a-f]{64}(?![0-9A-Za-z])/

/** Every file under `dir`, recursively; fails on a symlink (or any other non-file) in the tree. */
async function filesUnder(dir) {
  if ((await lstat(dir)).isSymbolicLink()) throw new Error(`${dir} is a symlink`)
  const entries = await readdir(dir, { withFileTypes: true, recursive: true })
  const odd = entries.find((e) => !e.isFile() && !e.isDirectory())
  if (odd) throw new Error(`Not a file or folder in out/main: ${join(odd.parentPath, odd.name)}`)
  return entries.filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name))
}

/**
 * The job-run.exe pin compiled into the production main bundle. Every file under out/main
 * is searched for the pin's marker, which must appear exactly once in the whole tree, with a
 * valid digest, in a chunk of the graph Rollup recorded in out/main/.build-manifest.json from
 * the main entry (package.json `main`) through its static and dynamic imports. Fails on any
 * symlink under out/main, and unless every chunk in that graph is inside out/main and none is
 * a test-only entry.
 */
export async function bundledPin(root = repoRoot) {
  const mainDir = resolve(root, 'out', 'main')
  const inMain = (file) => {
    const rel = relative(mainDir, file)
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
  }
  const { main } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const entry = resolve(root, main ?? '')
  if (typeof main !== 'string' || !existsSync(entry) || !inMain(entry))
    throw new Error(`package.json main (${main}) is not a bundle in out/main`)
  const files = await filesUnder(mainDir)
  const manifestFile = join(mainDir, BUILD_MANIFEST)
  if (!existsSync(manifestFile))
    throw new Error(`The main build wrote no ${BUILD_MANIFEST}: rebuild with \`pnpm build\``)
  const { chunks } = JSON.parse(await readFile(manifestFile, 'utf8'))
  if (typeof chunks !== 'object' || chunks === null)
    throw new Error(`${manifestFile} lists no chunks`)
  const chunkOf = (file) => relative(mainDir, file).split(sep).join('/')
  const start = chunkOf(entry)
  if (!Object.hasOwn(chunks, start) || chunks[start]?.isEntry !== true)
    throw new Error(`${BUILD_MANIFEST} has no entry ${start}`)
  const graph = new Set()
  const queue = [start]
  while (queue.length) {
    const file = resolve(mainDir, queue.pop())
    const name = chunkOf(file)
    if (graph.has(file)) continue
    if (TEST_ENTRIES.includes(name))
      throw new Error(`The production main bundle loads a test-only entry: ${name}`)
    const chunk = Object.hasOwn(chunks, name) ? chunks[name] : undefined
    if (!chunk || !name.endsWith('.js') || !existsSync(file) || !inMain(file))
      throw new Error(`Cannot resolve chunk ${name} inside out/main`)
    graph.add(file)
    for (const edge of [chunk.imports ?? [], chunk.dynamicImports ?? []].flat()) {
      if (typeof edge !== 'string') throw new Error(`${BUILD_MANIFEST}: bad import of ${name}`)
      queue.push(edge)
    }
  }
  const markers = []
  for (const file of files) {
    const text = await readFile(file, 'latin1')
    for (let at = text.indexOf(MARKER_PREFIX); at !== -1; at = text.indexOf(MARKER_PREFIX, at + 1))
      markers.push({ file, digest: DIGEST.exec(text.slice(at + MARKER_PREFIX.length))?.[0] })
  }
  if (markers.length === 0)
    throw new Error('The app was built without the job-run.exe pin: rebuild after build:helpers')
  if (markers.length !== 1)
    throw new Error(
      `out/main has the job-run.exe pin marker ${markers.length} times: ${markers.map((m) => relative(mainDir, m.file)).join(', ')}`,
    )
  const [{ file: pinned, digest }] = markers
  if (!digest) throw new Error(`An invalid job-run.exe pin in ${pinned}`)
  if (!graph.has(pinned))
    throw new Error(`The job-run.exe pin is outside the production main bundle: ${pinned}`)
  return digest
}

/**
 * afterPack: resources/helpers/job-run.exe is present, hardened, matches this build's pin,
 * and the production main bundle carries that same pin.
 */
export async function verifyHelpers(resources) {
  const pin = readPin()
  if (!pin) throw new Error('job-run.exe was not built: run `pnpm build:helpers` before packaging')
  const bytes = await readFile(join(resources, ...PINNED_PATH.split('/')))
  if (sha256(bytes) !== pin) throw new Error('Packaged job-run.exe does not match its pin')
  checkHardening(bytes)
  if ((await bundledPin()) !== sha256(bytes))
    throw new Error('The app was built with another job-run.exe pin: rebuild after build:helpers')
  console.log(`Verified packaged job-run.exe ${JOB_RUN_VERSION} (sha256 ${pin}).`)
}
