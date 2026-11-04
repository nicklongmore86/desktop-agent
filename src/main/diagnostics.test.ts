import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({}))
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs, renameSync: vi.fn(fs.renameSync) }
})

const {
  CrashLoopGuard,
  createLogger,
  fatalHandlers,
  formatLogArgs,
  recoveryPrompt,
  redactText,
  RotatingLogFile,
  routeConsole,
  watchRenderer,
} = await import('./diagnostics')
const { cancelOnPageEnd } = await import('./chat/lifecycle')

const SECRETS = [
  'sk-ant-api03-abcDEF123456',
  'sk-proj-abcDEF123456',
  'AIzaSyA1234567890abcdefghijklmnop',
  'ghp_abcdefghij1234567890',
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJl',
  'ya29.a0AfH6SMabc123',
  'AKIAIOSFODNN7EXAMPLE',
]

describe('redactText', () => {
  it.each(SECRETS)('removes the key or token %s', (secret) => {
    expect(redactText(`request failed with ${secret} attached`, '/nowhere')).toBe(
      'request failed with [redacted] attached',
    )
  })

  it.each([
    ['Authorization: Bearer abc.def-123456', 'abc.def-123456'],
    ['x-api-key: plainvalue', 'plainvalue'],
    ['{"apiKey":"plain value"}', 'plain value'],
    ["api_key='plainvalue'", 'plainvalue'],
    ['refresh_token=plainvalue&x=1', 'plainvalue'],
    ['"access_token": "plain value"', 'plain value'],
    ['client_secret=plainvalue', 'plainvalue'],
    ['Cookie: plainvalue', 'plainvalue'],
    ['GET https://auth.example/cb?code=plainvalue&state=1', 'plainvalue'],
    ['https://user:plainvalue@example.com/', 'plainvalue'],
  ])('removes the value in %s', (text, value) => {
    expect(redactText(text, '/nowhere')).not.toContain(value)
    expect(redactText(text, '/nowhere')).toContain('[redacted]')
  })

  it.each([
    ['400 {"messages":[{"role":"user","content":"my private prompt"}]}', 'my private prompt'],
    ['{"prompt":"my private prompt","model":"x"}', 'my private prompt'],
    ["{ content: 'my private file line' }", 'my private file line'],
    ['"text":"cut off in the mid', 'cut off'],
    ['"file_data":"ZmlsZQ"', 'ZmlsZQ'],
  ])('removes the body in %s', (text, value) => {
    expect(redactText(text, '/nowhere')).not.toContain(value)
  })

  it('removes encoded data: data URIs and long runs', () => {
    expect(redactText('img data:image/png;base64,iVBORw0KGgo= end', '/nowhere')).toBe(
      'img data:[redacted] end',
    )
    expect(redactText(`blob ${'QUJD'.repeat(40)} end`, '/nowhere')).toBe('blob [redacted] end')
  })

  it('keeps a long absolute path, as in a stack frame, but not encoded data with slashes', () => {
    const frame =
      'at f (file:///home/runner/work/desktop-agent/desktop-agent/src/main/some/deep/dir/x.ts:1:2)'
    expect(redactText(frame, '/nowhere')).toBe(frame)
    const blob = `${'QUJD'.repeat(12)}/${'QUJD'.repeat(12)}`
    expect(redactText(`blob ${blob} end`, '/nowhere')).toBe('blob [redacted] end')
    expect(redactText(`blob /${'QUJD'.repeat(20)} end`, '/nowhere')).toBe('blob [redacted] end')
  })

  it('shortens the home folder, which names the user', () => {
    expect(redactText('could not read C:\\Users\\Ann\\x.txt', 'C:\\Users\\Ann')).toBe(
      'could not read ~\\x.txt',
    )
  })

  it('keeps what a log is for', () => {
    const line = 'could not save the conversation: ENOENT at chat.json line 12'
    expect(redactText(line, '/nowhere')).toBe(line)
    const sha = '083abe0e14ed6c6deec28d0e92bc418e718abcde'
    expect(redactText(`commit ${sha}`, '/nowhere')).toContain(sha)
  })

  it('takes bounded time and output on a huge input', () => {
    const started = Date.now()
    const out = redactText(`"content":"${'x'.repeat(5_000_000)}`, '/nowhere')
    expect(Date.now() - started).toBeLessThan(2000)
    expect(out).not.toContain('xxx')
  })
})

describe('formatLogArgs', () => {
  it('logs an error by name, message, code and frames, never what else it carries', () => {
    const error = Object.assign(new Error('Request failed'), {
      code: 'E_API',
      request: { headers: { 'x-api-key': 'sk-ant-api03-abcDEF123456' } },
      body: { messages: [{ content: 'my private prompt' }] },
      attachment: Buffer.from('attachment bytes'),
    })
    const text = formatLogArgs(['send failed', error], '/nowhere')
    expect(text).toContain('send failed Error: Request failed [E_API]')
    expect(text).toContain('diagnostics.test.ts')
    for (const leak of ['sk-ant', 'my private prompt', 'attachment bytes', 'x-api-key']) {
      expect(text).not.toContain(leak)
    }
  })

  it('follows a cause, and redacts the messages of both', () => {
    const inner = new Error('token=plainvalue rejected')
    const text = formatLogArgs([new Error('sign-in failed', { cause: inner })], '/nowhere')
    expect(text).toContain('Caused by: Error: token=[redacted] rejected')
    expect(text).not.toContain('plainvalue')
  })

  it('shows objects by safe fields only, and no array or binary contents', () => {
    const text = formatLogArgs(
      [
        { path: 'a.txt', size: 3, content: 'secret line', apiKey: 'k', nested: { content: 'n' } },
        ['my private prompt'],
        Buffer.from('file bytes'),
        new Uint8Array(4),
      ],
      '/nowhere',
    )
    expect(text).toBe(
      '{ path: a.txt, size: 3, content: [redacted], apiKey: [redacted], nested: [object] } ' +
        '[array of 1] [binary, 10 bytes] [binary, 4 bytes]',
    )
  })

  it('survives values that throw', () => {
    const hostile = {
      get path(): string {
        throw new Error('no')
      },
    }
    expect(formatLogArgs([hostile, 1, null, undefined], '/nowhere')).toBe(
      '[unreadable] 1 null undefined',
    )
  })

  it('caps a record, and a pasted line break cannot forge a new one', () => {
    expect(formatLogArgs(['y'.repeat(500_000)], '/nowhere').length).toBeLessThan(400)
    const forged = formatLogArgs(['a\n2026-01-01T00:00:00.000Z ERROR forged'], '/nowhere')
    expect(forged).toBe('a ...[truncated]')
    expect(formatLogArgs(['a b\u0007c'], '/nowhere')).toBe('a b c')
  })
})

describe('formatLogArgs, the limit on free text', () => {
  const PROMPT = 'Summarise my contract\nThe rent is 900 a month\n\nmy private second paragraph'
  const leaks = ['The rent is', 'second paragraph']

  it.each([
    ['alone', [PROMPT]],
    ['last', ['sending', 'to', PROMPT]],
    ['first', [PROMPT, 'failed', 3]],
    ['in the middle', ['sending', PROMPT, { path: 'a.txt' }]],
  ])('keeps only the first line of a multi-line string %s', (_where, args) => {
    const text = formatLogArgs(args, '/nowhere')
    expect(text).toContain('Summarise my contract ...[truncated]')
    for (const leak of leaks) expect(text).not.toContain(leak)
  })

  it.each([
    ['CRLF', 'first\r\nmy private rest'],
    ['CR', 'first\rmy private rest'],
    ['a line separator', 'first\u2028my private rest'],
    ['a paragraph separator', 'first\u2029my private rest'],
    ['a next line', 'first\u0085my private rest'],
    ['a form feed', 'first\fmy private rest'],
  ])('counts %s as the end of the line', (_name, text) => {
    expect(formatLogArgs([text], '/nowhere')).toBe('first ...[truncated]')
  })

  it('caps one long line, and says so', () => {
    const line = 'word '.repeat(200)
    const text = formatLogArgs([line], '/nowhere')
    expect(text).toBe(`${line.slice(0, 300)} ...[truncated]`)
  })

  it('leaves an ordinary message as it is, whatever whitespace surrounds it', () => {
    const line = 'could not save the conversation: ENOSPC'
    expect(formatLogArgs([line], '/nowhere')).toBe(line)
    expect(formatLogArgs([`\n\n  ${line}\n`], '/nowhere')).toBe(line)
    expect(formatLogArgs(['x'.repeat(30).replaceAll('x', 'ab ')], '/nowhere')).not.toContain(
      'truncated',
    )
  })

  it('still redacts a secret on a single line, and one the cut would have split', () => {
    expect(formatLogArgs(['key is sk-ant-api03-abcDEF123456 ok'], '/nowhere')).toBe(
      'key is [redacted] ok',
    )
    const atTheCut = `${'word '.repeat(59)}sk-ant-api03-abcDEF123456`
    const text = formatLogArgs([atTheCut], '/nowhere')
    expect(text).not.toContain('sk-')
    expect(formatLogArgs(['token=', 'plainvalue'], '/nowhere')).not.toContain('plainvalue')
  })

  it('does not let a cut hide the home folder', () => {
    const home = '/home/somebody-with-a-name'
    const text = formatLogArgs([`${'a '.repeat(145)}${home}/secret.txt`], home)
    expect(text).not.toContain('somebody')
  })

  it('applies to the fields of a logged object, and its keys', () => {
    const text = formatLogArgs(
      [{ path: 'a.txt\nmy private rest', 'odd\nmy private rest': 1 }],
      '/nowhere',
    )
    expect(text).toBe('{ path: a.txt ...[truncated], odd ...[truncated]: 1 }')
  })

  it('keeps an error first line and its frames, not the rest of its message', () => {
    const error = new Error(`Request failed\n${PROMPT}`)
    const text = formatLogArgs(['send failed', error], '/nowhere')
    expect(text).toContain('send failed Error: Request failed ...[truncated]')
    expect(text).toMatch(/\n {4}at .*diagnostics\.test\.ts:\d+:\d+/)
    for (const leak of leaks) expect(text).not.toContain(leak)
  })

  it('does not take a line of an error message for a stack frame', () => {
    const plain = new Error('failed\n   at the beach with my private prompt\n')
    expect(formatLogArgs([plain], '/nowhere')).not.toContain('the beach')
    // Even when the line is frame-shaped: what the message said is not a frame.
    const pasted = new Error('failed\n   at privateFunction (my-private-file.ts:1:2)')
    expect(formatLogArgs([pasted], '/nowhere')).not.toContain('privateFunction')
    // Or when the stack no longer starts with the message: it was changed after the capture.
    const changed = new Error('changed')
    changed.stack =
      'Error: my private prompt\n   at the shops with my private prompt\n   at real (file.js:1:2)'
    const text = formatLogArgs([changed], '/nowhere')
    expect(text).not.toContain('the shops')
    expect(text).toContain('at real (file.js:1:2)')
  })

  it('reaches the file the same way through the console route', () => {
    const dir = mkdtempSync(join(tmpdir(), 'desktop-agent-log-'))
    try {
      const file = new RotatingLogFile({ dir })
      const target = { debug: vi.fn(), log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
      const restore = routeConsole(
        createLogger(file, { now: () => new Date(0), home: '/nowhere' }),
        target as unknown as Console,
      )
      target.info('library says', PROMPT, 'and', 'sk-ant-api03-abcDEF123456')
      restore()
      expect(readFileSync(join(dir, 'main.log'), 'utf8')).toBe(
        '1970-01-01T00:00:00.000Z INFO  library says Summarise my contract ...[truncated] and [redacted]\n',
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('RotatingLogFile', () => {
  let dir: string
  const read = (name: string): string => readFileSync(join(dir, name), 'utf8')

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'desktop-agent-log-'))
  })
  afterEach(() => {
    vi.mocked(renameSync).mockClear()
    rmSync(dir, { recursive: true, force: true })
  })

  it('creates the folder and appends', () => {
    const nested = join(dir, 'logs')
    const log = new RotatingLogFile({ dir: nested })
    log.write('one\n')
    log.write('two\n')
    expect(readFileSync(join(nested, 'main.log'), 'utf8')).toBe('one\ntwo\n')
  })

  it('moves a full file aside and keeps no more than maxFiles', () => {
    const log = new RotatingLogFile({ dir, maxBytes: 10, maxFiles: 3 })
    for (const line of ['aaaaaaaa\n', 'bbbbbbbb\n', 'cccccccc\n', 'dddddddd\n', 'eeeeeeee\n']) {
      log.write(line)
    }
    expect(readdirSync(dir).sort()).toEqual(['main.1.log', 'main.2.log', 'main.log'])
    expect(read('main.log')).toBe('eeeeeeee\n')
    expect(read('main.1.log')).toBe('dddddddd\n')
    expect(read('main.2.log')).toBe('cccccccc\n')
  })

  it('counts what an earlier run left in the file', () => {
    writeFileSync(join(dir, 'main.log'), 'x'.repeat(9))
    new RotatingLogFile({ dir, maxBytes: 10 }).write('next\n')
    expect(read('main.log')).toBe('next\n')
    expect(read('main.1.log')).toBe('x'.repeat(9))
  })

  it('never exceeds the cap with one huge line', () => {
    new RotatingLogFile({ dir, maxBytes: 10 }).write('z'.repeat(100))
    expect(statSync(join(dir, 'main.log')).size).toBe(10)
  })

  it('stays under the cap when rotating is refused (a file held open on Windows)', () => {
    const log = new RotatingLogFile({ dir, maxBytes: 10 })
    log.write('aaaaaaaa\n')
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('busy'), { code: 'EBUSY' })
    })
    log.write('bbbbbbbb\n')
    expect(read('main.log')).toBe('bbbbbbbb\n')
  })

  it('swallows a failure to write', () => {
    const file = join(dir, 'taken')
    writeFileSync(file, '')
    expect(() => {
      new RotatingLogFile({ dir: file }).write('line\n')
    }).not.toThrow()
  })
})

describe('createLogger and routeConsole', () => {
  it('writes one timestamped, redacted line', () => {
    const write = vi.fn()
    createLogger({ write }, { now: () => new Date(0), home: '/nowhere' }).log(
      'warn',
      'key',
      'sk-ant-api03-abcDEF123456',
    )
    expect(write).toHaveBeenCalledWith('1970-01-01T00:00:00.000Z WARN  key [redacted]\n')
  })

  it('routes every console method through the logger, and back', () => {
    const log = vi.fn()
    const target = {
      debug: vi.fn(),
      log: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }
    const original = { ...target }
    const restore = routeConsole({ log }, target as unknown as Console)
    target.debug('a')
    target.log('b')
    target.info('c')
    target.warn('d')
    target.error('e', 1)
    expect(log.mock.calls).toEqual([
      ['debug', 'a'],
      ['info', 'b'],
      ['info', 'c'],
      ['warn', 'd'],
      ['error', 'e', 1],
    ])
    expect(original.error).not.toHaveBeenCalled()
    restore()
    expect(target.error).toBe(original.error)
  })
})

describe('CrashLoopGuard', () => {
  it('stops offering reload at the limit, and forgets old failures', () => {
    let now = 0
    const guard = new CrashLoopGuard({ limit: 3, windowMs: 1000, now: () => now })
    expect(guard.canReload()).toBe(true)
    guard.record()
    now = 100
    guard.record()
    expect(guard.canReload()).toBe(true)
    now = 200
    guard.record()
    expect(guard.canReload()).toBe(false)
    now = 1050
    expect(guard.canReload()).toBe(true)
  })
})

describe('recoveryPrompt', () => {
  it('offers Reload or Quit after a crash, and Esc cannot leave a dead window', () => {
    const plan = recoveryPrompt('crashed', true)
    expect(plan.buttons).toEqual(['Reload', 'Quit'])
    expect(plan.choices[plan.cancelId]).toBe('reload')
    expect(plan.detail).toContain('pending approvals were denied')
  })

  it('offers no reload once the guard has tripped', () => {
    const plan = recoveryPrompt('crashed', false)
    expect(plan.choices).toEqual(['quit', 'open-logs-and-quit'])
    expect(plan.choices[plan.cancelId]).toBe('quit')
    expect(recoveryPrompt('unresponsive', false).choices).toEqual(['wait', 'quit'])
  })

  it('offers waiting for a hang, and says what reloading would do', () => {
    const plan = recoveryPrompt('unresponsive', true)
    expect(plan.buttons).toEqual(['Keep waiting', 'Reload', 'Quit'])
    expect(plan.choices[plan.cancelId]).toBe('wait')
    expect(plan.detail).toContain('Reloading stops any reply')
  })
})

describe('watchRenderer', () => {
  function setup(answers: (string | Promise<string>)[] = []) {
    const listeners = new Map<string, (...args: unknown[]) => void>()
    const contents = {
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        listeners.set(event, listener)
      }),
      reload: vi.fn(),
      forcefullyCrashRenderer: vi.fn(),
      isDestroyed: vi.fn(() => false),
    }
    const window = { isDestroyed: vi.fn(() => false), webContents: contents }
    const show = vi.fn(async (_window: unknown, plan: { choices: readonly string[] }) => {
      const answer = await answers.shift()
      return answer === undefined ? 0 : plan.choices.indexOf(answer)
    })
    const deps = {
      logger: { log: vi.fn() },
      guard: new CrashLoopGuard({ limit: 3, windowMs: 60_000 }),
      show,
      quit: vi.fn(),
      openLogs: vi.fn(),
      isQuitting: vi.fn(() => false),
    }
    watchRenderer(window, deps)
    const emit = (event: string, ...args: unknown[]): void => {
      listeners.get(event)?.(...args)
    }
    const crash = (reason = 'crashed'): void => {
      emit('render-process-gone', {}, { reason, exitCode: 1 })
    }
    const settle = () => new Promise((resolve) => setImmediate(resolve))
    return { contents, window, deps, show, emit, crash, settle }
  }

  it('reloads after a crash when asked', async () => {
    const { contents, crash, settle, deps } = setup(['reload'])
    crash()
    await settle()
    expect(contents.reload).toHaveBeenCalledOnce()
    expect(deps.quit).not.toHaveBeenCalled()
  })

  it('quits after a crash when asked', async () => {
    const { contents, crash, settle, deps } = setup(['quit'])
    crash()
    await settle()
    expect(deps.quit).toHaveBeenCalledOnce()
    expect(contents.reload).not.toHaveBeenCalled()
  })

  it('stops offering reload to a renderer that keeps crashing', async () => {
    const { contents, crash, settle, show, deps } = setup([
      'reload',
      'reload',
      'open-logs-and-quit',
    ])
    for (let i = 0; i < 3; i += 1) {
      crash()
      await settle()
    }
    expect(contents.reload).toHaveBeenCalledTimes(2)
    expect(show.mock.calls[2]?.[1].choices).toEqual(['quit', 'open-logs-and-quit'])
    expect(deps.openLogs).toHaveBeenCalledOnce()
    expect(deps.quit).toHaveBeenCalledOnce()
  })

  it('says nothing when the renderer goes because the app is quitting', async () => {
    const { crash, settle, show, deps } = setup()
    deps.isQuitting.mockReturnValue(true)
    crash('clean-exit')
    await settle()
    expect(show).not.toHaveBeenCalled()
  })

  describe('a renderer that exits normally', () => {
    const exit = (emit: (event: string, ...args: unknown[]) => void): void => {
      emit('render-process-gone', {}, { reason: 'clean-exit', exitCode: 0 })
    }

    it('is not logged as a crash or asked about, and the page comes back', async () => {
      const { contents, emit, settle, show, deps } = setup()
      exit(emit)
      await settle()
      expect(show).not.toHaveBeenCalled()
      expect(deps.logger.log.mock.calls).toEqual([
        ['info', 'renderer exited normally (exit code 0)'],
      ])
      expect(contents.reload).toHaveBeenCalledOnce()
    })

    it('does nothing more when the window has gone or the app is quitting', async () => {
      for (const quitting of [true, false]) {
        const { contents, window, emit, settle, show, deps } = setup()
        deps.isQuitting.mockReturnValue(quitting)
        window.isDestroyed.mockReturnValue(!quitting)
        exit(emit)
        await settle()
        expect(show).not.toHaveBeenCalled()
        expect(contents.reload).not.toHaveBeenCalled()
      }
      const { contents, emit, settle } = setup()
      contents.isDestroyed.mockReturnValue(true)
      exit(emit)
      await settle()
      expect(contents.reload).not.toHaveBeenCalled()
    })

    it('still ends the run, through the handler that does so', () => {
      const contents = Object.assign(new EventEmitter(), {
        reload: vi.fn(),
        forcefullyCrashRenderer: vi.fn(),
        isDestroyed: () => false,
      })
      const cancel = vi.fn()
      const show = vi.fn(() => Promise.resolve(0))
      watchRenderer(
        { isDestroyed: () => false, webContents: contents },
        {
          logger: { log: vi.fn() },
          guard: new CrashLoopGuard(),
          show,
          quit: vi.fn(),
          openLogs: vi.fn(),
          isQuitting: () => false,
        },
      )
      cancelOnPageEnd(contents, cancel)
      contents.emit('render-process-gone', {}, { reason: 'clean-exit', exitCode: 0 })
      expect(cancel).toHaveBeenCalledOnce()
      expect(show).not.toHaveBeenCalled()
    })

    it('stops reloading a page that keeps exiting, and offers a way out that is not a crash', async () => {
      const { contents, emit, settle, show, deps } = setup(['open-logs-and-quit'])
      for (let i = 0; i < 3; i += 1) {
        exit(emit)
        await settle()
      }
      expect(contents.reload).toHaveBeenCalledTimes(2)
      expect(show).toHaveBeenCalledOnce()
      const plan = show.mock.calls[0]?.[1] as unknown as { message: string; detail: string }
      expect(`${plan.message} ${plan.detail}`).not.toMatch(/crash/i)
      expect(deps.openLogs).toHaveBeenCalledOnce()
      expect(deps.quit).toHaveBeenCalledOnce()
      expect(deps.logger.log.mock.calls.filter(([level]) => level === 'error')).toEqual([])
    })

    it('takes down a prompt about a hang, and a later hang can ask again', async () => {
      const { contents, emit, settle, show } = setup([new Promise<string>(() => undefined), 'wait'])
      emit('unresponsive')
      await settle()
      expect(show).toHaveBeenCalledOnce()
      const signal = show.mock.calls[0]?.[2 as never] as AbortSignal
      exit(emit)
      await settle()
      expect(signal.aborted).toBe(true)
      expect(contents.reload).toHaveBeenCalledOnce()
      emit('unresponsive')
      await settle()
      expect(show).toHaveBeenCalledTimes(2)
    })

    it('counts as the hung renderer going, when this code killed it to reload', async () => {
      const { contents, emit, settle, show } = setup(['reload'])
      emit('unresponsive')
      await settle()
      exit(emit)
      await settle()
      expect(contents.reload).toHaveBeenCalledOnce()
      expect(show).toHaveBeenCalledOnce()
    })
  })

  it('kills a hung renderer and reloads once it has gone, without calling that a crash', async () => {
    const { contents, emit, crash, settle, show } = setup(['reload', 'reload'])
    emit('unresponsive')
    await settle()
    expect(contents.forcefullyCrashRenderer).toHaveBeenCalledOnce()
    // A reload sent before the exit gets lost, leaving a dead page.
    expect(contents.reload).not.toHaveBeenCalled()
    crash('killed')
    await settle()
    expect(contents.reload).toHaveBeenCalledOnce()
    expect(show).toHaveBeenCalledOnce()
    // A later crash is one.
    crash()
    expect(show).toHaveBeenCalledTimes(2)
  })

  it('counts reloads of a hung renderer towards the limit', async () => {
    const { emit, settle, show, crash } = setup(['reload', 'reload', 'reload', 'wait'])
    for (let i = 0; i < 3; i += 1) {
      emit('unresponsive')
      await settle()
      crash('killed')
      await settle()
    }
    emit('unresponsive')
    await settle()
    expect(show.mock.calls[3]?.[1].choices).toEqual(['wait', 'quit'])
  })

  it('does nothing when told to keep waiting', async () => {
    const { contents, emit, settle, deps } = setup(['wait'])
    emit('unresponsive')
    await settle()
    expect(contents.reload).not.toHaveBeenCalled()
    expect(contents.forcefullyCrashRenderer).not.toHaveBeenCalled()
    expect(deps.quit).not.toHaveBeenCalled()
  })

  it('takes the prompt away when the renderer recovers, ignoring any late answer', async () => {
    let answer: (choice: string) => void = () => undefined
    const { contents, emit, settle, show } = setup([
      new Promise((resolve) => {
        answer = resolve
      }),
    ])
    emit('unresponsive')
    emit('unresponsive')
    expect(show).toHaveBeenCalledOnce()
    const signal = show.mock.calls[0] as unknown as [unknown, unknown, AbortSignal]
    emit('responsive')
    expect(signal[2].aborted).toBe(true)
    answer('reload')
    await settle()
    expect(contents.reload).not.toHaveBeenCalled()
  })

  it('replaces a hang prompt with the crash prompt when the renderer dies under it', async () => {
    const { emit, crash, settle, show, contents } = setup([new Promise(() => undefined), 'reload'])
    emit('unresponsive')
    await settle()
    crash()
    await settle()
    expect((show.mock.calls[0] as unknown as [unknown, unknown, AbortSignal])[2].aborted).toBe(true)
    expect(show.mock.calls[1]?.[1].choices).toEqual(['reload', 'quit'])
    expect(contents.reload).toHaveBeenCalledOnce()
  })

  it('does not reload a window closed while the prompt was up', async () => {
    const { contents, window, crash, settle } = setup(['reload'])
    crash()
    window.isDestroyed.mockReturnValue(true)
    await settle()
    expect(contents.reload).not.toHaveBeenCalled()
  })

  it('takes the safe answer when the prompt itself fails', async () => {
    const { contents, show, crash, settle, deps } = setup()
    show.mockRejectedValueOnce(new Error('no display'))
    crash()
    await settle()
    expect(contents.reload).toHaveBeenCalledOnce()
    expect(deps.logger.log).toHaveBeenCalledWith(
      'error',
      'could not show the recovery prompt',
      expect.any(Error),
    )
  })
})

describe('fatalHandlers', () => {
  function setup(started = true) {
    const deps = {
      logger: { log: vi.fn() },
      isStarted: vi.fn(() => started),
      logsPath: '/data/logs',
      showError: vi.fn(),
      quit: vi.fn(),
    }
    return { deps, handlers: fatalHandlers(deps) }
  }

  it('logs an uncaught exception, says so, and closes', () => {
    const { deps, handlers } = setup()
    const error = new Error('boom')
    handlers.uncaughtException(error)
    expect(deps.logger.log).toHaveBeenCalledWith('error', 'fatal: uncaught exception:', error)
    expect(deps.showError.mock.calls[0]?.[1]).toContain('/data/logs')
    expect(deps.quit).toHaveBeenCalledOnce()
  })

  it('closes even if the dialog cannot be shown', () => {
    const { deps, handlers } = setup()
    deps.showError.mockImplementation(() => {
      throw new Error('no display')
    })
    handlers.uncaughtException(new Error('boom'))
    expect(deps.quit).toHaveBeenCalledOnce()
  })

  it('shows one dialog when errors follow each other, and logs them all', () => {
    const { deps, handlers } = setup()
    handlers.uncaughtException(new Error('one'))
    handlers.uncaughtException(new Error('two'))
    expect(deps.showError).toHaveBeenCalledOnce()
    expect(deps.quit).toHaveBeenCalledOnce()
    expect(deps.logger.log).toHaveBeenCalledTimes(2)
  })

  it('only logs a rejection once the app is running', () => {
    const { deps, handlers } = setup(true)
    handlers.unhandledRejection(new Error('one task'))
    expect(deps.logger.log).toHaveBeenCalledOnce()
    expect(deps.showError).not.toHaveBeenCalled()
    expect(deps.quit).not.toHaveBeenCalled()
  })

  it('closes on a rejection before there is a window: a failed startup', () => {
    const { deps, handlers } = setup(false)
    handlers.unhandledRejection(new Error('services failed'))
    expect(deps.showError).toHaveBeenCalledOnce()
    expect(deps.quit).toHaveBeenCalledOnce()
  })
})
