// job-run.exe (native/job-run): the build's pins file and the checks shared by
// build-job-helper.mjs, the Vite build (which compiles the digest into the app) and afterPack.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
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

/**
 * afterPack: resources/helpers/job-run.exe is present, hardened, matches this build's pin,
 * and the compiled main bundle carries that same pin.
 */
export async function verifyHelpers(resources) {
  const pin = readPin()
  if (!pin) throw new Error('job-run.exe was not built: run `pnpm build:helpers` before packaging')
  const bytes = await readFile(join(resources, ...PINNED_PATH.split('/')))
  if (sha256(bytes) !== pin) throw new Error('Packaged job-run.exe does not match its pin')
  checkHardening(bytes)
  const main = join(repoRoot, 'out', 'main')
  const bundles = await Promise.all(
    (await readdir(main)).filter((f) => f.endsWith('.js')).map((f) => readFile(join(main, f))),
  )
  if (!bundles.some((code) => code.includes(pin)))
    throw new Error('The app was built without the job-run.exe pin: rebuild after build:helpers')
  console.log(`Verified packaged job-run.exe ${JOB_RUN_VERSION} (sha256 ${pin}).`)
}
