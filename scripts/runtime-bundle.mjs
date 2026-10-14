import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

// The single source of truth for pinned digests, also compiled into the app.
const pins = JSON.parse(
  await readFile(new URL('../src/main/providers/runtime-pins.json', import.meta.url), 'utf8'),
)['win32-x64']
const asset = 'codex-package-x86_64-pc-windows-msvc.tar.gz'
const release = 'https://github.com/openai/codex/releases/download/rust-v0.162.1/'
const archiveHash = pins.codex.archiveSha256
const claudePath = pins.claude.executable
const claudeHash = pins.claude.files[claudePath]
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
async function download(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Download failed: ${response.status} ${url}`)
  return Buffer.from(await response.arrayBuffer())
}
function check(bytes, hash, label) {
  if (sha(bytes) !== hash) throw new Error(`Integrity mismatch: ${label}`)
}
const sorted = (record) =>
  Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
async function inventory(root, prefix = '') {
  const result = {}
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) Object.assign(result, await inventory(root, path))
    else if (entry.isFile()) result[path] = sha(await readFile(join(root, path)))
    else throw new Error(`Unexpected non-regular bundle entry: ${path}`)
  }
  return result
}

export async function prepare() {
  const stage = resolve('build/runtime-bundle')
  await rm(stage, { recursive: true, force: true })
  await mkdir(join(stage, 'codex'), { recursive: true })
  // The pinned digest is from this exact official GitHub release asset, not an npm wrapper.
  const archive = await download(release + asset)
  check(archive, archiveHash, asset)
  const archivePath = resolve('build/codex.tar.gz')
  await writeFile(archivePath, archive)
  execFileSync('tar', ['-xzf', archivePath, '-C', join(stage, 'codex')])
  await rm(archivePath)
  const notices = join(stage, 'notices')
  await mkdir(notices)
  for (const [name, hash] of [
    ['LICENSE', 'd17f227e4df5da1600391338865ce0f3055211760a36688f816941d58232d8dc'],
    ['NOTICE', '9d71575ecfd9a843fc1677b0efb08053c6ba9fd686a0de1a6f5382fd3c220915'],
  ]) {
    const bytes = await download(
      `https://raw.githubusercontent.com/openai/codex/rust-v0.162.1/${name}`,
    )
    check(bytes, hash, name)
    await writeFile(join(notices, `Codex-${name}`), bytes)
  }
  const manifestUrl = 'https://downloads.claude.ai/claude-code-releases/2.1.299/manifest.json'
  const manifest = await download(manifestUrl)
  const parsed = JSON.parse(manifest)
  if (parsed.version !== '2.1.299' || parsed.platforms['win32-x64'].checksum !== claudeHash)
    throw new Error('Official Claude release manifest disagrees with pinned digest')
  const native = 'node_modules/@anthropic-ai/claude-agent-sdk-win32-x64'
  check(await readFile(join(native, 'claude.exe')), claudeHash, 'Claude runtime')
  await cp(join(native, 'LICENSE.md'), join(notices, 'Claude-runtime-LICENSE.md'))
  await cp(
    'node_modules/@anthropic-ai/claude-agent-sdk/LICENSE.md',
    join(notices, 'Claude-SDK-LICENSE.md'),
  )
  await cp('THIRD-PARTY-NOTICES.md', join(notices, 'THIRD-PARTY-NOTICES.md'))
  await writeFile(join(notices, 'Claude-release-manifest.json'), manifest)
  const files = sorted(await inventory(stage))
  const codex = Object.fromEntries(
    Object.entries(files)
      .filter(([path]) => path.startsWith('codex/'))
      .map(([path, hash]) => [`runtimes/${path}`, hash]),
  )
  if (JSON.stringify(codex) !== JSON.stringify(sorted(pins.codex.files)))
    throw new Error('Codex release contents disagree with runtime-pins.json')
  await writeFile(
    join(stage, 'integrity.json'),
    JSON.stringify(
      {
        codex: { version: '0.162.1', url: release + asset, sha256: archiveHash },
        claude: { version: '2.1.299', url: manifestUrl, sha256: claudeHash, path: claudePath },
        files,
      },
      null,
      2,
    ) + '\n',
  )
}

export async function verify(resources) {
  const root = join(resources, 'runtimes')
  const manifest = JSON.parse(await readFile(join(root, 'integrity.json'), 'utf8'))
  if (manifest.codex.sha256 !== archiveHash || manifest.claude.sha256 !== claudeHash)
    throw new Error('Unexpected packaged runtime pins')
  for (const [path, hash] of Object.entries(manifest.files))
    check(await readFile(join(root, path)), hash, path)
  // The app refuses to run anything that differs from these compiled-in digests.
  for (const pin of [pins.claude, pins.codex])
    for (const [path, hash] of Object.entries(pin.files))
      check(await readFile(join(resources, path)), hash, path)
  for (const path of [
    'codex/bin/codex.exe',
    'codex/bin/codex-code-mode-host.exe',
    'codex/codex-path/rg.exe',
    'codex/codex-resources/codex-command-runner.exe',
    'codex/codex-resources/codex-windows-sandbox-setup.exe',
    'codex/codex-package.json',
    'notices/Codex-LICENSE',
    'notices/Codex-NOTICE',
    'notices/Claude-runtime-LICENSE.md',
    'notices/Claude-SDK-LICENSE.md',
  ]) {
    if (!manifest.files[path]) throw new Error(`Required runtime file missing: ${path}`)
  }
  console.log(
    `Verified packaged Claude 2.1.299 and complete Codex 0.162.1 bundle (${Object.keys(manifest.files).length} files).`,
  )
}

export default async function beforePack(context) {
  if (context.electronPlatformName !== 'win32' || context.arch !== 1)
    throw new Error('Runtime packaging currently supports Windows x64 only')
  await prepare()
}
