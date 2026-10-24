import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { JobLauncher } from '../tools/job-launcher'
import { pngShell } from './fixtures.test-util'
import {
  createSystemHeifDecoder,
  HEIC_NO_CODEC,
  HEIC_NO_HEIF,
  HEIC_NO_HEVC,
  HEIC_NOT_WINDOWS,
  parseDecoderReport,
  runDecoder,
  type RunDecoder,
  type SystemDecodeOptions,
} from './system-heif'

const LIMITS: SystemDecodeOptions = {
  longEdge: 1568,
  maxPixels: 100_000_000,
  maxInputBytes: 100 * 1024 * 1024,
  memoryBytes: 1536 * 1024 * 1024,
  timeoutMs: 30_000,
  maxOutputBytes: 100 * 1024 * 1024,
}
const PHOTO = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70])
const found = () =>
  Promise.resolve({ ok: true as const, path: 'C:\\app\\helpers\\heif-decode.exe' })

/** A decoder over a fake heif-decode.exe that answers the probe with `probe`, a decode with `decode`. */
function decoderWith(
  probe: string,
  decode: Awaited<ReturnType<RunDecoder>> = {
    stdout: pngShell(1568, 1176),
    report: 'heif-decode:1 ok width=1568 height=1176\n',
  },
  platform: NodeJS.Platform = 'win32',
) {
  const run = vi.fn<RunDecoder>((_file, args) =>
    Promise.resolve(args[0] === '--probe' ? { stdout: new Uint8Array(), report: probe } : decode),
  )
  const findDecoder = vi.fn<() => Promise<JobLauncher>>(found)
  return { decoder: createSystemHeifDecoder({ platform, findDecoder, run }), run, findDecoder }
}
const BOTH = 'heif-decode:1 probe heif=1 hevc=1\n'

describe('the HEIC system decoder', () => {
  it('is not offered off Windows, and never runs anything there', async () => {
    const { decoder, run, findDecoder } = decoderWith(BOTH, undefined, 'linux')
    await expect(decoder.support()).resolves.toEqual({
      supported: false,
      reason: HEIC_NOT_WINDOWS,
    })
    await expect(decoder.decode(PHOTO, LIMITS)).rejects.toMatchObject({
      code: 'unsupported',
      message: HEIC_NOT_WINDOWS,
    })
    expect(run).not.toHaveBeenCalled()
    expect(findDecoder).not.toHaveBeenCalled()
  })

  it('says exactly which Store package is missing', async () => {
    const cases = [
      ['heif-decode:1 probe heif=0 hevc=0\n', HEIC_NO_CODEC],
      ['heif-decode:1 probe heif=1 hevc=0\n', HEIC_NO_HEVC],
      ['heif-decode:1 probe heif=0 hevc=1\n', HEIC_NO_HEIF],
    ] as const
    for (const [probe, reason] of cases) {
      const { decoder, run } = decoderWith(probe)
      await expect(decoder.support()).resolves.toEqual({ supported: false, reason })
      await expect(decoder.decode(PHOTO, LIMITS)).rejects.toMatchObject({
        code: 'unsupported',
        message: reason,
      })
      // Only the probe ran: a decode is never tried without the codec.
      expect(run).toHaveBeenCalledTimes(1)
    }
    expect(HEIC_NO_CODEC).toMatch(/Microsoft Store.*export it as JPEG/)
  })

  it('probes once per session, however often it is asked', async () => {
    const { decoder, run } = decoderWith(BOTH)
    const answers = await Promise.all([decoder.support(), decoder.support(), decoder.support()])
    await decoder.decode(PHOTO, LIMITS)
    await decoder.support()
    expect(answers).toEqual([{ supported: true }, { supported: true }, { supported: true }])
    expect(run.mock.calls.filter(([, args]) => args[0] === '--probe')).toHaveLength(1)
  })

  it('never rejects when probing fails, whatever the way', async () => {
    const failures: (() => ReturnType<RunDecoder>)[] = [
      () => Promise.resolve({ failed: 'spawn' }),
      () => Promise.resolve({ failed: 'timeout' }),
      () => Promise.resolve({ stdout: new Uint8Array(), report: 'garbage\n' }),
      () => Promise.resolve({ stdout: new Uint8Array(), report: '' }),
      () => Promise.reject(new Error('boom')),
      () => {
        throw new Error('sync boom')
      },
    ]
    for (const failure of failures) {
      const decoder = createSystemHeifDecoder({
        platform: 'win32',
        findDecoder: found,
        run: failure,
      })
      const support = await decoder.support()
      expect(support.supported).toBe(false)
      if (!support.supported) expect(support.reason).toMatch(/HEIC decoder is not available/)
    }
    const lockdown = createSystemHeifDecoder({
      platform: 'win32',
      findDecoder: found,
      run: () =>
        Promise.resolve({
          stdout: new Uint8Array(),
          report: 'heif-decode:1 error=low-integrity code=0x80070005\n',
        }),
    })
    await expect(lockdown.support()).resolves.toMatchObject({
      reason: expect.stringContaining('it could not start: low-integrity') as unknown,
    })
    const thrown = createSystemHeifDecoder({
      platform: 'win32',
      findDecoder: () => Promise.reject(new Error('no')),
    })
    await expect(thrown.support()).resolves.toMatchObject({ supported: false })
  })

  it('refuses when the bundled decoder fails its check, saying why', async () => {
    const run = vi.fn<RunDecoder>()
    const decoder = createSystemHeifDecoder({
      platform: 'win32',
      findDecoder: () =>
        Promise.resolve({ ok: false, reason: 'heif-decode.exe failed its integrity check' }),
      run,
    })
    await expect(decoder.support()).resolves.toEqual({
      supported: false,
      reason:
        'This photo is HEIC, and the app’s HEIC decoder is not available (heif-decode.exe failed its integrity check). Export it as JPEG and try again.',
    })
    expect(run).not.toHaveBeenCalled()
  })

  it('checks the decoder again before each decode', async () => {
    const { decoder, findDecoder } = decoderWith(BOTH)
    await decoder.support()
    findDecoder.mockResolvedValueOnce({
      ok: false,
      reason: 'heif-decode.exe is not a regular file',
    })
    await expect(decoder.decode(PHOTO, LIMITS)).rejects.toMatchObject({
      code: 'unsupported',
      message: expect.stringContaining('not a regular file') as unknown,
    })
  })

  it('runs the decode with the bytes on stdin and every limit on the command line', async () => {
    const { decoder, run } = decoderWith(BOTH)
    const png = await decoder.decode(PHOTO, { ...LIMITS, longEdge: 1568.7 })
    expect(png).toEqual(pngShell(1568, 1176))
    const [file, args, input, limits] = run.mock.calls.at(-1) ?? []
    expect(file).toBe('C:\\app\\helpers\\heif-decode.exe')
    expect(args).toEqual([
      '--decode',
      '--format',
      'heif',
      '--long-edge',
      '1568',
      '--max-pixels',
      '100000000',
      '--max-input',
      String(100 * 1024 * 1024),
      '--max-memory',
      String(1536 * 1024 * 1024),
    ])
    expect(input).toBe(PHOTO)
    expect(limits).toMatchObject({ timeoutMs: 30_000, maxOutputBytes: 100 * 1024 * 1024 })
  })

  it('turns each reported failure into the right refusal', async () => {
    const cases = [
      ['too-many-pixels', '80070057', 'too-many-pixels'],
      ['input-too-large', '80070057', 'too-large'],
      ['no-decoder', '88982F50', 'unsupported'],
      ['decode', '88982F50', 'unsupported'],
      ['decode', 'C00D5212', 'unsupported'],
      ['decode', '8007000E', 'memory'],
      ['decode', '88982F61', 'malformed'],
      ['open', '88982F61', 'malformed'],
      ['job-assign', '80070005', 'worker-failed'],
      ['usage', '80070057', 'worker-failed'],
    ] as const
    for (const [step, code, expected] of cases) {
      const report = `heif-decode:1 error=${step} code=0x${code}\n`
      const { decoder } = decoderWith(BOTH, { stdout: new Uint8Array(), report })
      await expect(decoder.decode(PHOTO, LIMITS)).rejects.toMatchObject({ code: expected })
    }
  })

  it('refuses output that is not what it should be, without looking further', async () => {
    const bad: Awaited<ReturnType<RunDecoder>>[] = [
      { failed: 'output' },
      { failed: 'spawn' },
      { stdout: new Uint8Array([1, 2, 3]), report: 'heif-decode:1 ok width=10 height=10\n' },
      { stdout: pngShell(10, 10), report: '' },
      { stdout: pngShell(2000, 10), report: 'heif-decode:1 ok width=2000 height=10\n' },
    ]
    for (const decode of bad) {
      const { decoder } = decoderWith(BOTH, decode)
      await expect(decoder.decode(PHOTO, LIMITS)).rejects.toMatchObject({ code: 'worker-failed' })
    }
    const { decoder } = decoderWith(BOTH, { failed: 'timeout' })
    await expect(decoder.decode(PHOTO, LIMITS)).rejects.toMatchObject({ code: 'timeout' })
  })
})

describe('parseDecoderReport', () => {
  it('accepts only the exact lines heif-decode.exe writes', () => {
    expect(parseDecoderReport('heif-decode:1 probe heif=1 hevc=0\n')).toEqual({
      kind: 'probe',
      heif: true,
      hevc: false,
    })
    expect(parseDecoderReport('heif-decode:1 ok width=32 height=64\r\n')).toEqual({
      kind: 'ok',
      width: 32,
      height: 64,
    })
    expect(parseDecoderReport('heif-decode:1 error=decode code=0x88982F50\n')).toEqual({
      kind: 'error',
      step: 'decode',
      code: 0x88982f50,
    })
    for (const bad of [
      '',
      'heif-decode:1 ok width=32 height=64',
      'noise\nheif-decode:1 ok width=32 height=64\n',
      'heif-decode:1 ok width=32 height=64\nmore\n',
      'heif-decode:2 ok width=32 height=64\n',
      'heif-decode:1 ok width=123456 height=64\n',
      'heif-decode:1 error=Decode code=0x88982F50\n',
      'heif-decode:1 probe heif=2 hevc=0\n',
    ]) {
      expect(parseDecoderReport(bad)).toBeNull()
    }
  })
})

describe('runDecoder (a real child process)', () => {
  const script = (body: string): string => {
    const file = join(mkdtempSync(join(tmpdir(), 'heif-run-')), 'fake.cjs')
    writeFileSync(file, body)
    return file
  }
  // node <script> stands in for the exe: runDecoder passes its args after the file.
  const node = (
    file: string,
    input: Uint8Array | null,
    limits = { timeoutMs: 5000, maxOutputBytes: 1024 },
  ) => runDecoder(process.execPath, [file], input, limits)

  it('passes stdin, collects stdout and the report on stderr', async () => {
    const file = script(
      "const c=[];process.stdin.on('data',d=>c.push(d));process.stdin.on('end',()=>{process.stdout.write(Buffer.concat(c).reverse());process.stderr.write('heif-decode:1 ok width=1 height=1\\n')})",
    )
    await expect(node(file, new Uint8Array([1, 2, 3]))).resolves.toEqual({
      stdout: new Uint8Array([3, 2, 1]),
      report: 'heif-decode:1 ok width=1 height=1\n',
    })
  })

  it('kills a decoder that runs too long or writes too much', async () => {
    const slow = script('setTimeout(() => {}, 60_000)')
    await expect(node(slow, null, { timeoutMs: 200, maxOutputBytes: 10 })).resolves.toEqual({
      failed: 'timeout',
    })
    const loud = script('process.stdout.write(Buffer.alloc(4096)); setTimeout(() => {}, 60_000)')
    await expect(node(loud, null, { timeoutMs: 5000, maxOutputBytes: 1024 })).resolves.toEqual({
      failed: 'output',
    })
  })

  it('reports a decoder that cannot be started', async () => {
    await expect(
      runDecoder(join(tmpdir(), 'no-such-heif-decode.exe'), [], null, {
        timeoutMs: 1000,
        maxOutputBytes: 10,
      }),
    ).resolves.toEqual({ failed: 'spawn' })
  })
})
