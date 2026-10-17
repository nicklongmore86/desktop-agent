// Builds job-run.exe (native/job-run) with MSVC into build/helpers and pins its SHA-256 in
// build/job-helper-pins.json, which the Vite build compiles into the app. Windows only;
// elsewhere it does nothing, and the app falls back to its plain tree kill.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  checkHardening,
  helperFile,
  JOB_RUN_VERSION,
  PINNED_PATH,
  pinsFile,
  repoRoot,
  sha256,
} from './job-helper.mjs'

if (process.platform !== 'win32') {
  console.log('job-run.exe is built on Windows only; skipped.')
  process.exit(0)
}

const source = join(repoRoot, 'native', 'job-run')
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
await mkdir(dirname(helperFile), { recursive: true })
const script = join(objects, 'build.cmd')
// /Brepro: no timestamps, so the same compiler gives the same bytes.
await writeFile(
  script,
  [
    '@echo off',
    `call "${vcvars}" >nul || exit /b 1`,
    `cd /d "${objects}" || exit /b 1`,
    'echo MSVC %VCToolsVersion%',
    `rc /nologo /fo job-run.res "${join(source, 'job-run.rc')}" || exit /b 1`,
    `cl /nologo /c /O1 /MT /GS /guard:cf /W4 /WX /Brepro /Fojob-run.obj "${join(source, 'job-run.c')}" || exit /b 1`,
    'link /nologo /Brepro /DYNAMICBASE /HIGHENTROPYVA /NXCOMPAT /guard:cf /CETCOMPAT ' +
      '/DEPENDENTLOADFLAG:0x800 /SUBSYSTEM:CONSOLE /OUT:job-run.exe job-run.obj job-run.res ' +
      'kernel32.lib || exit /b 1',
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
const bytes = await readFile(join(objects, 'job-run.exe'))
checkHardening(bytes)
await writeFile(helperFile, bytes)
const hash = sha256(bytes)
await writeFile(
  pinsFile,
  JSON.stringify(
    {
      [PINNED_PATH]: {
        version: JOB_RUN_VERSION,
        sha256: hash,
        size: bytes.length,
        compiler: /MSVC (\S+)/.exec(log)?.[1] ?? 'unknown',
      },
    },
    null,
    2,
  ) + '\n',
)
console.log(`Built ${helperFile} (${bytes.length} bytes, sha256 ${hash}).`)
