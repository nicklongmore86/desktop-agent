import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  extractLoginUrl,
  LOGIN_CODE_PATTERN,
  sanitizeOutput,
  validateLoginUrl,
} from './claude-login'
import { capture, discoverRuntime, launch } from './runtime'
import { SubscriptionProviders } from './service'

vi.mock('./runtime', async (original) => {
  const actual = await original<typeof import('./runtime')>()
  return { ...actual, capture: vi.fn(), discoverRuntime: vi.fn(), launch: vi.fn(actual.launch) }
})
const { launch: realLaunch } = await vi.importActual<typeof import('./runtime')>('./runtime')

const URL = 'https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz'

// Stands in for `claude auth login` (pinned 2.1.299): the same three stdout lines, the
// prompt without a trailing newline, then waiting on stdin. A real child process, so
// stdin, stderr, exit codes and killing behave as they do on Windows and Linux.
const FAKE = `
const fs = require('node:fs')
const mode = process.env.FAKE_MODE
fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify(process.argv.slice(2)))
const url = process.env.FAKE_URL
const link = '\\x1b]8;;' + url + '\\x07\\x1b[4m' + url + '\\x1b[24m\\x1b]8;;\\x07'
process.stdout.write('\\x1b[1mOpening browser to sign in…\\x1b[22m\\r\\n')
process.stdout.write("If the browser didn't open, visit: " + link + '\\n')
process.stdout.write('Paste code here if prompted > ')
if (mode === 'fail')
  process.stderr.write('\\x1b[31mOAuth error:\\x1b[0m token exchange failed\\n', () => {
    process.exit(3)
  })
else if (mode === 'callback')
  process.stdout.write('\\nLogin successful.\\n', () => {
    process.exit(0)
  })
else wait()
function wait() {
if (mode === 'slow-stderr') process.stderr.write('still waiting for the browser\\n')
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  input += chunk
  if (!input.includes('\\n')) return
  fs.appendFileSync(process.env.FAKE_LOG, '\\n' + input)
  process.stdout.write('Login successful.\\n', () => {
    process.exit(0)
  })
})
setInterval(() => {}, 1000)
}
`

let dir: string
let script: string
let log: string
let children: ChildProcessWithoutNullStreams[]
let openUrl: ReturnType<typeof vi.fn<(url: string) => Promise<void>>>
let onLoginUrl: ReturnType<typeof vi.fn<(provider: string, url: string) => void>>

function useFake(mode: string, url = URL) {
  vi.mocked(launch).mockImplementation((_file, args, cwd, env) => {
    const child = realLaunch(process.execPath, [script, ...args], cwd, {
      ...env,
      FAKE_MODE: mode,
      FAKE_URL: url,
      FAKE_LOG: log,
    })
    children.push(child)
    return child
  })
}

function providers(loginTimeout?: number) {
  return new SubscriptionProviders(dir, openUrl, {
    onLoginUrl,
    ...(loginTimeout ? { loginTimeout } : {}),
  })
}

async function waitForUrl(provider: SubscriptionProviders) {
  await vi.waitFor(
    () => {
      expect(provider.loginUrl).toBeDefined()
    },
    { timeout: 10000 },
  )
}

const firstChild = () => {
  const child = children[0]
  if (!child) throw new Error('The runtime was not launched.')
  return child
}

const exited = async (child: ChildProcessWithoutNullStreams) => {
  if (child.exitCode === null && child.signalCode === null) await once(child, 'exit')
  return true
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'claude login '))
  script = join(dir, 'fake-claude.js')
  log = join(dir, 'fake.log')
  await writeFile(script, FAKE)
  children = []
  openUrl = vi.fn(() => Promise.resolve())
  onLoginUrl = vi.fn()
  vi.mocked(discoverRuntime).mockResolvedValue(process.execPath)
  vi.mocked(capture).mockResolvedValue(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }))
})
afterEach(async () => {
  for (const child of children) child.kill('SIGKILL')
  vi.clearAllMocks()
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

describe('Claude subscription sign-in', { timeout: 30000 }, () => {
  it('opens the printed link from main, shows it, and completes on the localhost callback', async () => {
    useFake('callback')
    const status = await providers().login('claude-subscription')
    expect(status).toMatchObject({ state: 'ready' })
    expect(openUrl).toHaveBeenCalledExactlyOnceWith(URL)
    expect(onLoginUrl).toHaveBeenCalledExactlyOnceWith('claude-subscription', URL)
    // Same verified runtime and restricted environment as every other runtime launch.
    const [file, args, , env] = vi.mocked(launch).mock.calls[0] ?? []
    expect(file).toBe(process.execPath)
    expect(args).toEqual(['auth', 'login'])
    expect(env).toMatchObject({ CLAUDE_CONFIG_DIR: join(dir, 'providers', 'claude') })
    expect(Object.keys(env ?? {}).some((key) => /API_KEY|OAUTH_TOKEN/i.test(key))).toBe(false)
  })

  it('writes a valid pasted code to the runtime and refreshes to signed in', async () => {
    useFake('paste')
    const provider = providers()
    const login = provider.login('claude-subscription')
    await waitForUrl(provider)
    expect(provider.submitLoginCode('  abc123#state456 ')).toEqual({ ok: true })
    expect(await login).toMatchObject({ provider: 'claude-subscription', state: 'ready' })
    expect(capture).toHaveBeenCalledWith(
      process.execPath,
      ['auth', 'status'],
      expect.anything(),
      expect.anything(),
      expect.anything(),
    )
    expect((await readFile(log, 'utf8')).split('\n').slice(1).join('\n')).toBe('abc123#state456\n')
  })

  it.each(['', 'abc123', 'abc#def#ghi', 'abc 123#def', '#state', 'code#', 'a#b\nc#d', 42])(
    'rejects the malformed code %j without writing it',
    async (code) => {
      useFake('paste')
      const provider = providers()
      const login = provider.login('claude-subscription')
      await waitForUrl(provider)
      expect(provider.submitLoginCode(code)).toMatchObject({ ok: false })
      provider.cancelLogin()
      expect(await login).toMatchObject({ state: 'error', message: 'Sign-in cancelled.' })
      expect(await readFile(log, 'utf8')).toBe('["auth","login"]')
    },
  )

  it('re-opens only the same validated link', async () => {
    useFake('paste')
    const provider = providers()
    const login = provider.login('claude-subscription')
    await waitForUrl(provider)
    await provider.openLoginUrl()
    expect(openUrl.mock.calls).toEqual([[URL], [URL]])
    provider.cancelLogin()
    await login
    await expect(provider.openLoginUrl()).rejects.toThrow('No sign-in link')
  })

  it.each([
    'http://claude.com/oauth',
    'https://evil.example/oauth',
    'https://claude.ai.evil.example/oauth',
    'https://evilclaude.ai/oauth',
    'https://console.claude.com/oauth',
    'https://user:pass@claude.ai/oauth',
    'https://claude.ai@evil.example/oauth',
    'https://claude.ai:8443/oauth',
    'javascript:alert(1)',
    'file:///C:/Windows/System32/calc.exe',
  ])('never opens the rejected link %s and shows an error', async (url) => {
    useFake('paste', url)
    const status = await providers().login('claude-subscription')
    expect(status).toMatchObject({
      state: 'error',
      message: expect.stringContaining('unexpected sign-in link') as unknown,
    })
    expect(openUrl).not.toHaveBeenCalled()
    expect(onLoginUrl).not.toHaveBeenCalled()
    expect(await exited(firstChild())).toBe(true)
  })

  it('includes sanitized stderr when the runtime fails', async () => {
    useFake('fail')
    const status = await providers().login('claude-subscription')
    expect(status).toMatchObject({ state: 'error' })
    expect(status.message).toBe(
      'Claude sign-in failed (exit code 3). OAuth error: token exchange failed',
    )
  })

  it('times out visibly, with stderr, and stops the runtime', async () => {
    useFake('slow-stderr')
    const status = await providers(1500).login('claude-subscription')
    expect(status).toMatchObject({ state: 'error' })
    expect(status.message).toBe('Sign-in timed out. Try again. still waiting for the browser')
    expect(await exited(firstChild())).toBe(true)
  })

  it('cancel kills the waiting runtime', async () => {
    useFake('paste')
    const provider = providers()
    const login = provider.login('claude-subscription')
    await waitForUrl(provider)
    const child = firstChild()
    provider.cancelLogin()
    expect(await login).toMatchObject({ state: 'error', message: 'Sign-in cancelled.' })
    expect(await exited(child)).toBe(true)
    expect(provider.submitLoginCode('abc#def')).toMatchObject({ ok: false })
  })
})

describe('sign-in link parsing', () => {
  it('extracts the link from escape-wrapped output and ignores other lines', () => {
    expect(
      extractLoginUrl(
        `\x1b[2mIf the browser didn't open, visit:\x1b[22m \x1b]8;;${URL}\x1b\\${URL}\x1b]8;;\x1b\\`,
      ),
    ).toBe(URL)
    expect(extractLoginUrl(`If the browser didn't open, visit: <${URL}>`)).toBe(URL)
    expect(extractLoginUrl('Opening browser to sign in…')).toBeUndefined()
    expect(extractLoginUrl(`Visit ${URL}`)).toBeUndefined()
  })
  it('accepts only the exact Claude hosts over https', () => {
    for (const host of ['claude.com', 'claude.ai', 'platform.claude.com'])
      expect(validateLoginUrl(`https://${host}/oauth/authorize?x=1`)).toBe(
        `https://${host}/oauth/authorize?x=1`,
      )
    expect(validateLoginUrl('https://CLAUDE.AI/oauth')).toBe('https://claude.ai/oauth')
    expect(validateLoginUrl('https://claude.ai./oauth')).toBeUndefined()
    expect(validateLoginUrl('not a url')).toBeUndefined()
  })
  it('matches the code format and sanitizes runtime output', () => {
    expect(LOGIN_CODE_PATTERN.test('abc#def')).toBe(true)
    expect(LOGIN_CODE_PATTERN.test('abc#def#')).toBe(false)
    expect(sanitizeOutput('\x1b[31mbad\x1b[0m\r\n\x07thing\t ')).toBe('bad thing')
  })
})
