// The real ocr-text.exe (native/ocr-text) on Windows: as `pnpm build:helpers` built it (the
// Windows check job) and as the installer packaged it (the installer job, with
// DESKTOP_TEST_RESOURCES set; run with -t 'packaged ocr-text.exe'). On Windows these fail
// rather than skip when the helper was not built.
//
// The pages are rendered on the runner with System.Drawing (ocr-fixtures.test-util.ts);
// GitHub's Windows runners have the en-US OCR language installed. Each test logs the
// helper's report (recognition time and peak commit) for the PR's numbers.
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { verifyPinnedHelper } from '../tools/job-launcher'
import {
  degrade,
  KNOWN_LINES,
  renderPage,
  toGray,
  wordRecall,
  type PageOptions,
} from './ocr-fixtures.test-util'
import {
  createSystemOcr,
  encodeOcrInput,
  OCR_TEXT_PATH,
  ocrMemoryLimit,
  parseOcrReport,
  runOcrHelper,
  type OcrImage,
  type OcrResult,
} from './system-ocr'

const BUILD = path.resolve('build')
const PINS = path.join(BUILD, 'job-helper-pins.json')
const MIB = 1024 * 1024
const SLOW = 180_000

function pin(): string {
  const hash = (JSON.parse(readFileSync(PINS, 'utf8')) as Record<string, { sha256?: string }>)[
    'helpers/ocr-text.exe'
  ]?.sha256
  if (!hash) throw new Error(`no ocr-text.exe pin in ${PINS}`)
  return hash
}

const ocrIn = (resources: string, sha256 = pin()) =>
  createSystemOcr({
    platform: 'win32',
    findHelper: () =>
      verifyPinnedHelper(
        { resources, sha256, grantedRoots: () => [], platform: 'win32' },
        OCR_TEXT_PATH,
      ),
  })

/** Pages are rendered once per file, on first use. */
const pages = new Map<string, OcrImage>()
function page(name: string, options: PageOptions, transform?: (page: OcrImage) => OcrImage) {
  let found = pages.get(name)
  if (!found) {
    found = renderPage(options)
    if (transform) found = transform(found)
    pages.set(name, found)
  }
  return found
}
const repeat = (count: number) =>
  Array.from({ length: count }, (_, i) => KNOWN_LINES[i % KNOWN_LINES.length] ?? '')
const CLEAN: PageOptions = { width: 2200, height: 1000, lines: KNOWN_LINES, fontPx: 40 }
const clean = () => page('clean', CLEAN)
const scanned = () =>
  page('scanned', { ...CLEAN, angle: 1.5, ink: 40 }, (rendered) => degrade(rendered))
const many = () => page('many', { width: 1568, height: 2200, lines: repeat(30), fontPx: 36 })
const edge = () => page('edge', { width: 4096, height: 2896, lines: repeat(28), fontPx: 56 })
const square = () => page('square', { width: 4096, height: 4096, lines: repeat(38), fontPx: 56 })

const texts = (result: OcrResult) => result.lines.map((line) => line.text)
const logResult = (label: string, image: OcrImage, result: OcrResult) => {
  console.log(
    `ocr-text ${label}: ${String(image.width)}x${String(image.height)} ${image.format}, ` +
      `${String(result.lines.length)} lines, ${result.language}, angle ${String(result.angle)}, ` +
      `ocr ${String(result.stats.ms)} ms, peak commit ${(result.stats.peakBytes / MIB).toFixed(1)} MiB ` +
      `(limit ${(ocrMemoryLimit(image.width, image.height) / MIB).toFixed(0)} MiB)`,
  )
}
const boxesInside = (result: OcrResult) => {
  for (const { box } of result.lines) {
    expect(box.width).toBeGreaterThan(0)
    expect(box.height).toBeGreaterThan(0)
    expect(box.x + box.width).toBeLessThanOrEqual(result.width)
    expect(box.y + box.height).toBeLessThanOrEqual(result.height)
  }
}

/** A raw header: magic, version, format, reserved, width, height. */
function header(
  fields: Partial<{
    magic: string
    version: number
    format: number
    reserved: number
    width: number
    height: number
  }>,
) {
  const bytes = Buffer.alloc(16)
  bytes.write(fields.magic ?? 'OCRP', 0, 'latin1')
  bytes[4] = fields.version ?? 1
  bytes[5] = fields.format ?? 2
  bytes.writeUInt16LE(fields.reserved ?? 0, 6)
  bytes.writeUInt32LE(fields.width ?? 4, 8)
  bytes.writeUInt32LE(fields.height ?? 4, 12)
  return bytes
}

function suite(resources: string) {
  const exePath = path.join(resources, ...OCR_TEXT_PATH)
  /** Runs the exe directly: `input` on stdin; the exit code, stdout and report. */
  const exe = (args: string[], input: Uint8Array) => {
    const result = spawnSync(exePath, args, { input, maxBuffer: 4 * MIB, timeout: 120_000 })
    const stderr = result.stderr.toString('latin1')
    return {
      status: result.status,
      stdout: result.stdout.toString('utf8'),
      stderr,
      report: parseOcrReport(stderr),
    }
  }
  const recognizeArgs = (inputBytes: number, more: string[] = []) => [
    '--recognize',
    '--input-bytes',
    String(inputBytes),
    '--max-memory',
    String(128 * MIB),
    ...more,
  ]

  beforeAll(() => {
    if (!existsSync(exePath) || !existsSync(PINS)) {
      throw new Error(`${exePath} is not built: run \`pnpm build:helpers\` first`)
    }
  })

  it('is verified against its pin, and reports the OCR languages after locking down', async () => {
    expect(
      await verifyPinnedHelper(
        { resources, sha256: pin(), grantedRoots: () => [], platform: 'win32' },
        OCR_TEXT_PATH,
      ),
    ).toMatchObject({ ok: true })
    const probe = exe(['--probe'], new Uint8Array())
    // The probe runs after the full lockdown: a failure here names its step.
    expect(probe.stderr).toMatch(/^ocr-text:1 probe languages=\d+ user=[01]\r?\n$/)
    expect(probe.status).toBe(0)
    const availability = await ocrIn(resources).probe()
    console.log(`ocr-text probe: ${probe.stdout.trim()} -> ${JSON.stringify(availability)}`)
    // The runners have en-US OCR; the user profile language is en-US.
    expect(availability).toMatchObject({ available: true, userLanguage: 'en-US' })
  })

  it(
    'reads a page of known text, with boxes on the lines',
    async () => {
      const image = clean()
      const result = await ocrIn(resources).recognize(image)
      logResult('clean', image, result)
      expect(result.language).toBe('en-US')
      expect(result.truncated).toBe(false)
      expect(wordRecall(KNOWN_LINES, texts(result))).toBeGreaterThanOrEqual(0.95)
      expect(texts(result).join('\n')).toContain('quick brown fox')
      boxesInside(result)
      // Top to bottom, starting about where the first line was drawn (80 px down).
      const tops = result.lines.map((line) => line.box.y)
      expect(tops).toEqual([...tops].sort((a, b) => a - b))
      expect(tops[0]).toBeGreaterThan(60)
      expect(tops[0]).toBeLessThan(140)
    },
    SLOW,
  )

  it(
    'reads the same page as Gray8',
    async () => {
      const image = toGray(clean())
      const result = await ocrIn(resources).recognize(image)
      logResult('gray8', image, result)
      expect(wordRecall(KNOWN_LINES, texts(result))).toBeGreaterThanOrEqual(0.95)
    },
    SLOW,
  )

  it(
    'reads a degraded page: skewed, low contrast, noisy, speckled',
    async () => {
      const image = scanned()
      const result = await ocrIn(resources).recognize(image)
      logResult('degraded', image, result)
      console.log(`ocr-text degraded text: ${JSON.stringify(texts(result))}`)
      expect(wordRecall(KNOWN_LINES, texts(result))).toBeGreaterThanOrEqual(0.8)
      boxesInside(result)
    },
    SLOW,
  )

  it(
    'reads a page at the 4096 px edge within its memory limit',
    async () => {
      const image = edge()
      const result = await ocrIn(resources).recognize(image)
      logResult('4096 edge', image, result)
      expect(wordRecall(repeat(28), texts(result))).toBeGreaterThanOrEqual(0.9)
      expect(result.stats.peakBytes).toBeLessThanOrEqual(ocrMemoryLimit(image.width, image.height))
      boxesInside(result)
    },
    SLOW,
  )

  it(
    'reads a 4096 x 4096 page, BGRA and Gray8, within the 256 MiB cap',
    async () => {
      const ocr = ocrIn(resources)
      for (const image of [square(), toGray(square())]) {
        const result = await ocr.recognize(image)
        logResult('4096 square', image, result)
        expect(wordRecall(repeat(38), texts(result))).toBeGreaterThanOrEqual(0.9)
        expect(result.stats.peakBytes).toBeLessThanOrEqual(256 * MIB)
      }
    },
    SLOW,
  )

  it(
    'refuses oversized and malformed headers before allocating',
    () => {
      const pixels = (count: number) => new Uint8Array(count).fill(255)
      const send = (head: Buffer, body: Uint8Array, inputBytes = head.length + body.length) =>
        exe(recognizeArgs(inputBytes), Buffer.concat([head, body]))
      const cases: [ReturnType<typeof exe>, string][] = [
        // 4097 on either side, without sending (or allocating) the 4097 x 4 pixels.
        [send(header({ width: 4097 }), new Uint8Array(), 16 + 4097 * 4), 'too-large'],
        [
          send(header({ height: 4097, format: 1 }), new Uint8Array(), 16 + 4 * 4097 * 4),
          'too-large',
        ],
        [
          send(header({ width: 0xffffffff, height: 0xffffffff }), new Uint8Array(), 1000),
          'too-large',
        ],
        [send(header({ magic: 'PNG\r' }), pixels(16)), 'bad-header'],
        [send(header({ version: 2 }), pixels(16)), 'bad-header'],
        [send(header({ reserved: 1 }), pixels(16)), 'bad-header'],
        [send(header({ width: 0 }), pixels(16)), 'bad-header'],
        [send(header({ format: 3 }), pixels(16)), 'bad-format'],
        // The header and --input-bytes disagree: refused before the pixel buffer exists.
        [send(header({ width: 4096, height: 4096 }), pixels(16)), 'size-mismatch'],
        [send(header({}), pixels(16), 16 + 17), 'size-mismatch'],
        // Fewer or more bytes than both say.
        [exe(recognizeArgs(32), Buffer.concat([header({}), pixels(15)])), 'input-truncated'],
        [exe(recognizeArgs(32), Buffer.concat([header({}), pixels(17)])), 'input-too-large'],
        [exe(recognizeArgs(32), header({}).subarray(0, 10)), 'input-truncated'],
      ]
      for (const [result, step] of cases) {
        expect(result.report, result.stderr).toMatchObject({ kind: 'error', step })
        expect(result.status).toBe(1)
        expect(result.stdout).toBe('')
      }
      for (const args of [
        [],
        ['--recognize'],
        ['--recognize', '--input-bytes', '32'],
        recognizeArgs(16),
        recognizeArgs(16 + 4 * 4096 * 4096 + 1),
        ['--recognize', '--input-bytes', '32', '--max-memory', String(257 * MIB)],
        ['--recognize', '--input-bytes', '32', '--max-memory', String(63 * MIB)],
        recognizeArgs(32, ['--max-output', '100']),
        recognizeArgs(32, ['--max-output', String(MIB + 1)]),
        recognizeArgs(32, ['--lang', 'en US']),
        recognizeArgs(32, ['--relax', 'job']),
        [...recognizeArgs(32), '--extra'],
        ['--probe', '--relax', 'job'],
      ]) {
        const result = exe(args, Buffer.concat([header({}), pixels(16)]))
        expect(result.report, `${args.join(' ')}: ${result.stderr}`).toMatchObject({
          kind: 'error',
          step: 'usage',
        })
        expect(result.status).toBe(1)
      }
    },
    SLOW,
  )

  it(
    'says when the requested language is not installed (exit 2)',
    () => {
      // The engine is created before the image is read, so a tiny one will do.
      const input = encodeOcrInput({
        width: 4,
        height: 4,
        format: 'gray8',
        pixels: new Uint8Array(16),
      })
      const result = exe(recognizeArgs(input.length, ['--lang', 'ja-JP']), input)
      expect(result.report, result.stderr).toMatchObject({
        kind: 'error',
        step: 'language-not-installed',
      })
      expect(result.status).toBe(2)
    },
    SLOW,
  )

  it(
    'truncates output at a line boundary, flagged, within the cap',
    async () => {
      const image = many()
      const full = await ocrIn(resources).recognize(image)
      logResult('30 lines', image, full)
      expect(full.truncated).toBe(false)
      expect(full.lines.length).toBeGreaterThanOrEqual(25)

      const input = encodeOcrInput(image)
      const direct = exe(recognizeArgs(input.length, ['--max-output', '1024']), input)
      expect(direct.status, direct.stderr).toBe(0)
      expect(Buffer.byteLength(direct.stdout)).toBeLessThanOrEqual(1024)
      const json = JSON.parse(direct.stdout) as {
        truncated: boolean
        lines: { text: string }[]
      }
      expect(json.truncated).toBe(true)
      expect(json.lines.length).toBeGreaterThan(0)
      expect(json.lines.length).toBeLessThan(full.lines.length)
      // The report counts only the lines emitted, in UTF-16 units.
      const chars = json.lines.reduce((n, line) => n + line.text.length, 0)
      expect(direct.report).toMatchObject({ kind: 'ok', lines: json.lines.length, chars })

      const capped = await ocrIn(resources).recognize(image, { maxOutputBytes: 1024 })
      expect(capped.truncated).toBe(true)
      expect(texts(capped)).toEqual(texts(full).slice(0, capped.lines.length))
    },
    SLOW,
  )

  it(
    'is killed when cancelled or past its deadline',
    async () => {
      const image = square()
      const input = encodeOcrInput(image)
      const args = [
        '--recognize',
        '--input-bytes',
        String(input.length),
        '--max-memory',
        String(ocrMemoryLimit(image.width, image.height)),
      ]
      // Straight at the process: aborted while it reads or recognises.
      const controller = new AbortController()
      const started = Date.now()
      setTimeout(() => {
        controller.abort()
      }, 150)
      await expect(
        runOcrHelper(exePath, args, input, {
          timeoutMs: 60_000,
          maxOutputBytes: MIB,
          signal: controller.signal,
        }),
      ).resolves.toEqual({ failed: 'cancelled' })
      console.log(`ocr-text cancelled and exited after ${String(Date.now() - started)} ms`)

      const ocr = ocrIn(resources)
      const running = ocr.recognize(image)
      setTimeout(() => {
        ocr.cancelAll()
      }, 150)
      await expect(running).rejects.toMatchObject({ code: 'cancelled' })
      await expect(ocr.recognize(image, { timeoutMs: 100 })).rejects.toMatchObject({
        code: 'timeout',
      })
    },
    SLOW,
  )

  it(
    'refuses a tampered helper without running it',
    async () => {
      const copy = mkdtempSync(path.join(tmpdir(), 'ocr-tampered-'))
      mkdirSync(path.join(copy, 'helpers'))
      const tampered = path.join(copy, ...OCR_TEXT_PATH)
      copyFileSync(exePath, tampered)
      const bytes = readFileSync(tampered)
      bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff
      writeFileSync(tampered, bytes)
      const ocr = ocrIn(copy)
      await expect(ocr.probe()).resolves.toMatchObject({
        available: false,
        reason: 'unavailable',
        message: expect.stringContaining('failed its integrity check') as string,
      })
      await expect(ocr.recognize(clean())).rejects.toMatchObject({
        code: 'unavailable',
        message: expect.stringContaining('failed its integrity check') as string,
      })
      // The untampered one, at the same pin, still works.
      await expect(ocrIn(resources).recognize(toGray(clean()))).resolves.toBeTruthy()
    },
    SLOW,
  )
}

describe.runIf(process.platform === 'win32')('ocr-text.exe', () => {
  suite(BUILD)
})

// The installed layout, in the installer CI job: the packaged helper matches the pin and runs.
describe.runIf(process.env.DESKTOP_TEST_RESOURCES)('packaged ocr-text.exe', () => {
  suite(process.env.DESKTOP_TEST_RESOURCES ?? '')
})
