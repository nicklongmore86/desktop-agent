// job-run.exe (native/job-run): the build's pins file and the checks shared by
// build-job-helper.mjs, the Vite build (which compiles the digest into the app) and afterPack.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
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
// Static require()/import/export-from of a string literal, as Rollup emits them.
const IMPORTS =
  /\brequire\(\s*(["'])([^"'\n]+)\1\s*\)|\b(?:import|export)\b[^"';]*?\bfrom\s*(["'])([^"'\n]+)\3|\bimport\s*\(\s*(["'])([^"'\n]+)\5\s*\)|\bimport\s*(["'])([^"'\n]+)\7/g
// job-launcher.ts's `JOB_RUN_SHA256 = ...` with __JOB_RUN_SHA256__ compiled in.
const PIN_DEFINITION = /\bJOB_RUN_SHA256(?:\$\d+)?\s*=([^;\n]*)/g

/**
 * The job-run.exe pin compiled into the production main bundle: the main entry (package.json
 * `main`) and the local chunks it statically loads, never other files under out/main (the
 * test-only entries, or anything else left there). Fails unless that graph resolves entirely
 * inside out/main and defines JOB_RUN_SHA256 exactly once, as one 64-hex digest.
 */
export async function bundledPin(root = repoRoot) {
  const mainDir = resolve(root, 'out', 'main')
  const realMain = existsSync(mainDir) ? realpathSync(mainDir) : mainDir
  // Inside out/main by path and, through any symlinks, on disk.
  const inMain = (file) =>
    [
      [mainDir, file],
      [realMain, existsSync(file) ? realpathSync(file) : file],
    ].every(([dir, f]) => {
      const rel = relative(dir, f)
      return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
    })
  const { main } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const entry = resolve(root, main ?? '')
  if (typeof main !== 'string' || !existsSync(entry) || !inMain(entry))
    throw new Error(`package.json main (${main}) is not a bundle in out/main`)
  const graph = new Map()
  const queue = [entry]
  while (queue.length) {
    const file = queue.pop()
    if (graph.has(file)) continue
    if (TEST_ENTRIES.some((name) => file === join(mainDir, name)))
      throw new Error(`The production main bundle loads a test-only entry: ${file}`)
    const code = await readFile(file, 'utf8')
    graph.set(file, code)
    for (const m of code.matchAll(IMPORTS)) {
      const spec = m[2] ?? m[4] ?? m[6] ?? m[8]
      if (!spec.startsWith('./') && !spec.startsWith('../')) continue // node: builtins, packages
      const target = resolve(dirname(file), spec)
      if (!target.endsWith('.js') || !existsSync(target) || !inMain(target))
        throw new Error(`Cannot resolve ${spec} from ${file} inside out/main`)
      queue.push(target)
    }
  }
  const pins = [...graph.values()].flatMap((code) =>
    [...code.matchAll(PIN_DEFINITION)].map((m) => [...new Set(m[1].match(/[0-9a-f]{64}/g))]),
  )
  if (pins.every((hashes) => hashes.length === 0))
    throw new Error('The app was built without the job-run.exe pin: rebuild after build:helpers')
  if (pins.length !== 1 || pins[0].length !== 1)
    throw new Error(
      `The production main bundle defines the job-run.exe pin ${pins.length} times, ` +
        `with ${pins.flat().join(', ')}`,
    )
  return pins[0][0]
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
