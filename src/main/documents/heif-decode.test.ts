// The real heif-decode.exe (native/heif-decode), on the Windows CI runner. `pnpm build:helpers`
// must have built it first: on Windows these tests fail rather than skip without it.
//
// GitHub's Windows runners (Windows Server) have no Microsoft Store, so neither "HEIF Image
// Extensions" nor "HEVC Video Extensions" is installed there: these tests run the probe and
// the codec-missing path for real, and the whole decode path (lockdown, WIC, scaling, the
// pixel cap, PNG out) with WIC's built-in JPEG decoder. If a runner ever has both codecs,
// the HEIC test decodes the real photo instead and logs whether WIC turned it upright.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { verifyPinnedHelper } from '../tools/job-launcher'
import { PLAIN_JPEG, ROTATED_HEIC } from './heif-fixtures.test-util'
import { imageDimensions } from './limits'
import {
  createSystemHeifDecoder,
  HEIF_DECODE_PATH,
  parseDecoderReport,
  type SystemDecodeOptions,
} from './system-heif'

const BUILD = path.resolve('build')
const DECODER = path.join(BUILD, ...HEIF_DECODE_PATH)
const PINS = path.join(BUILD, 'job-helper-pins.json')
const LIMITS: SystemDecodeOptions = {
  longEdge: 1568,
  maxPixels: 100_000_000,
  maxInputBytes: 100 * 1024 * 1024,
  memoryBytes: 1536 * 1024 * 1024,
  timeoutMs: 30_000,
  maxOutputBytes: 100 * 1024 * 1024,
}

function pin(): string {
  const hash = (JSON.parse(readFileSync(PINS, 'utf8')) as Record<string, { sha256?: string }>)[
    'helpers/heif-decode.exe'
  ]?.sha256
  if (!hash) throw new Error(`no heif-decode.exe pin in ${PINS}`)
  return hash
}

const decoderIn = (resources: string) =>
  createSystemHeifDecoder({
    platform: 'win32',
    findDecoder: () =>
      verifyPinnedHelper(
        { resources, sha256: pin(), grantedRoots: () => [], platform: 'win32' },
        HEIF_DECODE_PATH,
      ),
  })

/** Runs the exe directly: `input` on stdin; stdout bytes and the stderr report. */
function exe(args: string[], input: Uint8Array) {
  const result = spawnSync(DECODER, args, { input, maxBuffer: 64 * 1024 * 1024, timeout: 60_000 })
  return {
    status: result.status,
    stdout: new Uint8Array(result.stdout),
    report: parseDecoderReport(result.stderr.toString('latin1')),
    stderr: result.stderr.toString('latin1'),
  }
}
/** The exit status and stderr, for an assertion's message. */
const described = (result: ReturnType<typeof exe>) =>
  `exit ${String(result.status)}, stderr ${JSON.stringify(result.stderr)}`
const decodeArgs = (format: string, longEdge = 1568, maxPixels = 100_000_000) => [
  '--decode',
  '--format',
  format,
  '--long-edge',
  String(longEdge),
  '--max-pixels',
  String(maxPixels),
  '--max-input',
  String(10 * 1024 * 1024),
  '--max-memory',
  String(512 * 1024 * 1024),
]

describe.runIf(process.platform === 'win32')('heif-decode.exe', () => {
  beforeAll(() => {
    if (!existsSync(DECODER) || !existsSync(PINS)) {
      throw new Error('heif-decode.exe is not built: run `pnpm build:helpers` first')
    }
  })

  it('is verified against its pin, and probes for the codecs after locking itself down', async () => {
    expect(
      await verifyPinnedHelper(
        { resources: BUILD, sha256: pin(), grantedRoots: () => [], platform: 'win32' },
        HEIF_DECODE_PATH,
      ),
    ).toEqual({ ok: true, path: DECODER })
    const probe = exe(['--probe'], new Uint8Array())
    // The probe runs after the same lockdown as a decode: a failure here names its step.
    expect(probe.stderr).toMatch(/^heif-decode:1 probe heif=[01] hevc=[01]\r?\n$/)
    expect(probe.status).toBe(0)
    console.log(`heif-decode.exe on this runner: ${probe.stderr.trim()}`)
  })

  it('decodes a real HEIC photo, or refuses it saying what to install', async () => {
    const decoder = decoderIn(BUILD)
    const support = await decoder.support()
    if (!support.supported) {
      expect(support.reason).toMatch(/Microsoft Store/)
      await expect(decoder.decode(ROTATED_HEIC, LIMITS)).rejects.toMatchObject({
        code: 'unsupported',
        message: support.reason,
      })
      // Asked to decode anyway, the exe fails cleanly at the codec, not before.
      const direct = exe(decodeArgs('heif'), ROTATED_HEIC)
      expect(direct.status).toBe(1)
      expect(direct.report).toMatchObject({ kind: 'error' })
      expect(['no-decoder', 'open', 'frame', 'decode']).toContain(
        direct.report?.kind === 'error' ? direct.report.step : '',
      )
      console.log(`HEIC on this runner: ${support.reason} (direct: ${direct.stderr.trim()})`)
      return
    }
    const png = await decoder.decode(ROTATED_HEIC, LIMITS)
    const size = imageDimensions(png, 'png')
    // 64 x 32 as stored, 32 x 64 upright: which one says whether WIC applied irot.
    expect([
      { width: 64, height: 32 },
      { width: 32, height: 64 },
    ]).toContainEqual(size)
    console.log(`HEIC decoded by WIC at ${String(size?.width)} x ${String(size?.height)}`)
  })

  it('runs the whole decode path with WIC’s JPEG decoder: scaled, capped, PNG out', () => {
    const full = exe(decodeArgs('jpeg'), PLAIN_JPEG)
    expect(full.stderr).toBe('heif-decode:1 ok width=64 height=32\n')
    expect(imageDimensions(full.stdout, 'png')).toEqual({ width: 64, height: 32 })
    // No metadata chunks: just the image.
    expect(Buffer.from(full.stdout).includes(Buffer.from('eXIf'))).toBe(false)

    const scaled = exe(decodeArgs('jpeg', 16), PLAIN_JPEG)
    expect(scaled.report).toEqual({ kind: 'ok', width: 16, height: 8 })
    expect(imageDimensions(scaled.stdout, 'png')).toEqual({ width: 16, height: 8 })

    // The pixel cap, from the size the decoder reports, before any pixel is decoded.
    const capped = exe(decodeArgs('jpeg', 1568, 64 * 32 - 1), PLAIN_JPEG)
    expect(capped.report).toMatchObject({ kind: 'error', step: 'too-many-pixels' })
    expect(capped.stdout).toHaveLength(0)
  })

  it('refuses bad input and bad arguments cleanly', () => {
    const garbage = exe(decodeArgs('jpeg'), new Uint8Array([1, 2, 3]))
    expect(garbage.report, described(garbage)).toMatchObject({ kind: 'error' })
    // The JPEG decoder only ever sees the bytes it is told to: a JPEG is not HEIF.
    const notHeif = exe(decodeArgs('heif'), PLAIN_JPEG)
    expect(notHeif.report, described(notHeif)).toMatchObject({ kind: 'error' })
    const tooBig = exe(
      [
        ...decodeArgs('jpeg').slice(0, 7),
        '--max-input',
        '100',
        '--max-memory',
        String(512 * 1024 * 1024),
      ],
      PLAIN_JPEG,
    )
    expect(tooBig.report, described(tooBig)).toMatchObject({
      kind: 'error',
      step: 'input-too-large',
    })
    for (const args of [
      [],
      ['--decode'],
      ['--decode', '--format', 'png', ...decodeArgs('jpeg').slice(3)],
      [...decodeArgs('jpeg'), '--extra'],
      decodeArgs('jpeg').map((arg) => (arg === '1568' ? '-1' : arg)),
    ]) {
      const result = exe(args, PLAIN_JPEG)
      expect(result.report, described(result)).toMatchObject({ kind: 'error', step: 'usage' })
    }
  })
})

// The installed layout, in the installer CI job: the packaged decoder matches the pin and runs.
describe.runIf(process.env.DESKTOP_TEST_RESOURCES)('packaged heif-decode.exe', () => {
  const resources = process.env.DESKTOP_TEST_RESOURCES ?? ''

  it('is present at resources\\helpers, pinned, and answers the probe', async () => {
    const decoder = decoderIn(resources)
    const support = await decoder.support()
    // Either answer is fine; "not available" (a failed check or start) is not.
    if (!support.supported) expect(support.reason).not.toMatch(/not available/)
  })
})
