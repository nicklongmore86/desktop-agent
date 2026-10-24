// Builds the native helpers, job-run.exe (native/job-run) and heif-decode.exe
// (native/heif-decode), with MSVC into build/helpers and pins their SHA-256 in
// build/job-helper-pins.json, which the Vite build compiles into the app. Windows only;
// elsewhere it does nothing: the app falls back to its plain tree kill, and HEIC photos
// are not decoded.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  builtHelper,
  checkHardening,
  HEIF_DECODE,
  JOB_RUN,
  pinsFile,
  repoRoot,
  sha256,
} from './job-helper.mjs'

if (process.platform !== 'win32') {
  console.log('The native helpers are built on Windows only; skipped.')
  process.exit(0)
}

const objects = join(repoRoot, 'build', 'job-helper-obj')
const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
const vswhere = join(programFilesX86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')
if (!existsSync(vswhere)) throw new Error('Visual Studio (vswhere.exe) was not found')
const vs = execFileSync(
  vswhere,
  [
    '-latest',
    '-products',
    '*',
    '-requires',
    'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
    '-property',
    'installationPath',
  ],
  { encoding: 'utf8' },
).trim()
const vcvars = join(vs, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat')
if (!vs || !existsSync(vcvars)) throw new Error('The MSVC x64 build tools were not found')

await rm(objects, { recursive: true, force: true })
await mkdir(objects, { recursive: true })

/**
 * The helpers and what each links. heif-decode.exe decodes untrusted photos with Windows'
 * own codecs (WIC, Media Foundation), so it needs their libraries; job-run.exe needs only
 * kernel32. Both get the same hardening.
 */
const BUILDS = [
  { helper: JOB_RUN, libs: ['kernel32.lib'] },
  {
    helper: HEIF_DECODE,
    libs: [
      'kernel32.lib',
      'advapi32.lib',
      'ole32.lib',
      'windowscodecs.lib',
      'mfplat.lib',
      'mfuuid.lib',
      'uuid.lib',
    ],
  },
]

const pins = {}
for (const { helper, libs } of BUILDS) {
  const base = helper.name.replace(/\.exe$/, '')
  const source = join(repoRoot, 'native', base)
  const script = join(objects, `build-${base}.cmd`)
  // /Brepro: no timestamps, so the same compiler gives the same bytes.
  await writeFile(
    script,
    [
      '@echo off',
      `call "${vcvars}" >nul || exit /b 1`,
      `cd /d "${objects}" || exit /b 1`,
      'echo MSVC %VCToolsVersion%',
      `rc /nologo /fo ${base}.res "${join(source, `${base}.rc`)}" || exit /b 1`,
      `cl /nologo /c /O1 /MT /GS /guard:cf /W4 /WX /Brepro /Fo${base}.obj "${join(source, `${base}.c`)}" || exit /b 1`,
      'link /nologo /Brepro /DYNAMICBASE /HIGHENTROPYVA /NXCOMPAT /guard:cf /CETCOMPAT ' +
        `/DEPENDENTLOADFLAG:0x800 /SUBSYSTEM:CONSOLE /OUT:${helper.name} ${base}.obj ${base}.res ` +
        `${libs.join(' ')} || exit /b 1`,
      '',
    ].join('\r\n'),
  )
  let log
  try {
    log = execFileSync('cmd.exe', ['/d', '/c', script], { encoding: 'utf8' })
  } catch (error) {
    // cl and link report errors on stdout.
    process.stdout.write(error.stdout ?? '')
    throw error
  }
  process.stdout.write(log)
  const bytes = await readFile(join(objects, helper.name))
  checkHardening(bytes, helper.name)
  const file = builtHelper(helper)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, bytes)
  const hash = sha256(bytes)
  pins[helper.pinned] = {
    version: helper.version,
    sha256: hash,
    size: bytes.length,
    compiler: /MSVC (\S+)/.exec(log)?.[1] ?? 'unknown',
  }
  console.log(`Built ${file} (${bytes.length} bytes, sha256 ${hash}).`)
}
await writeFile(pinsFile, JSON.stringify(pins, null, 2) + '\n')
