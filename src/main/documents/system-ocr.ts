// Text in images, recognised by Windows' built-in OCR (Windows.Media.Ocr) through
// ocr-text.exe (native/ocr-text): no OCR engine or language data is bundled. See
// docs/ocr-text.md. search_files calls recognize() for scanned PDF pages (tools/search-ocr.ts).
import { spawn } from 'node:child_process'
import { availableParallelism, constants as osConstants, setPriority } from 'node:os'
import { installedResources, verifyPinnedHelper, type JobLauncher } from '../tools/job-launcher'

/**
 * The helper's SHA-256, compiled in at build time from the build's pins file as the marker
 * `ocr-text.exe-sha256:<digest>` (see scripts/job-helper.mjs); undefined in a build without
 * it and in tests.
 */
declare const __OCR_TEXT_PIN__: string | undefined

export const OCR_TEXT_SHA256: string | null =
  (typeof __OCR_TEXT_PIN__ === 'string' &&
    /^ocr-text\.exe-sha256:([0-9a-f]{64})$/.exec(__OCR_TEXT_PIN__)?.[1]) ||
  null

/** Where the installer puts the helper, relative to the app's resources folder. */
export const OCR_TEXT_PATH = ['helpers', 'ocr-text.exe'] as const

/** Longest image edge the helper accepts, in pixels (the helper checks it too). */
export const OCR_MAX_EDGE = 4096
/** Most JSON the helper may write, and main reads (the helper's own cap too). */
export const OCR_MAX_OUTPUT_BYTES = 1024 * 1024
/** The smallest output cap the helper accepts. */
export const OCR_MIN_OUTPUT_BYTES = 1024
/** Wall-clock limit per image unless the caller sets one; the helper's job also caps CPU at 60 s. */
export const OCR_DEFAULT_TIMEOUT_MS = 60_000
export const OCR_HEADER_BYTES = 16
const MIB = 1024 * 1024
/** The helper's Job Object memory limit: 64 MiB + 16 bytes per pixel, at most 256 MiB. */
export const ocrMemoryLimit = (width: number, height: number): number =>
  Math.min(256 * MIB, 64 * MIB + 16 * width * height)

export type OcrPixelFormat = 'bgra8' | 'gray8'
const BYTES_PER_PIXEL: Record<OcrPixelFormat, number> = { bgra8: 4, gray8: 1 }
const FORMAT_CODE: Record<OcrPixelFormat, number> = { bgra8: 1, gray8: 2 }

/** Raw pixels, rows top to bottom with no padding: what the caller decoded, never a file. */
export interface OcrImage {
  width: number
  height: number
  format: OcrPixelFormat
  pixels: Uint8Array
}

export interface OcrLine {
  text: string
  /** In the image's pixels. */
  box: { x: number; y: number; width: number; height: number }
}

export interface OcrResult {
  /** The recognizer's language (BCP 47). */
  language: string
  /** The text's angle in degrees, if Windows found one. */
  angle: number | null
  width: number
  height: number
  lines: OcrLine[]
  /** Lines past the output cap were dropped. */
  truncated: boolean
  /** Recognition time (not process start) and peak commit, from the helper's report. */
  stats: { ms: number; peakBytes: number }
}

export type OcrUnavailableReason = 'unsupported' | 'unavailable' | 'no-language'

/** Whether OCR can run here, and with which languages (for Settings and diagnostics). */
export type OcrAvailability =
  | { available: true; languages: string[]; userLanguage: string }
  | { available: false; reason: OcrUnavailableReason; message: string; languages: string[] }

export type OcrErrorCode =
  | OcrUnavailableReason
  | 'invalid-image'
  | 'too-large'
  | 'memory'
  | 'timeout'
  | 'cancelled'
  | 'output'
  | 'failed'

export class OcrError extends Error {
  constructor(
    readonly code: OcrErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'OcrError'
  }
}

export const OCR_NOT_WINDOWS =
  'Reading text in images uses Windows’ built-in text recognition (OCR), so it is available only on Windows.'
export const OCR_NO_LANGUAGE =
  'Windows has no text recognition (OCR) language installed. Add a language with “Optical character recognition” in Settings › Time & language › Language & region.'
export const ocrNoUserLanguage = (installed: readonly string[]): string =>
  `None of your Windows languages has text recognition (OCR) installed (OCR is installed for ${installed.join(', ')}). Add “Optical character recognition” to one of your languages in Settings › Time & language › Language & region.`
const ocrUnavailable = (why: string): string => `Text recognition (OCR) is not available (${why}).`

/** A BCP 47 tag as Windows reports one. */
const TAG = /^[A-Za-z0-9]{1,8}(?:-[A-Za-z0-9]{1,8}){0,7}$/
const validTag = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 85 && TAG.test(value)

const isEdge = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= OCR_MAX_EDGE

/**
 * The helper's stdin: the 16-byte header (see ocr-text.cpp) and a copy of the pixels, after
 * checking that they are exactly what the header says.
 */
export function encodeOcrInput(image: OcrImage): Buffer {
  const { width, height, format, pixels } = image
  if (!Object.hasOwn(BYTES_PER_PIXEL, format)) {
    throw new OcrError('invalid-image', `Unknown pixel format ${format as string}.`)
  }
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new OcrError('invalid-image', 'The image has no pixels.')
  }
  if (!isEdge(width) || !isEdge(height)) {
    throw new OcrError(
      'too-large',
      `The image is ${String(width)} × ${String(height)} pixels; text recognition reads at most ${String(OCR_MAX_EDGE)} on each side.`,
    )
  }
  const size = width * height * BYTES_PER_PIXEL[format]
  if (!(pixels instanceof Uint8Array) || pixels.byteLength !== size) {
    throw new OcrError(
      'invalid-image',
      `Expected ${String(size)} bytes of ${format} pixels, got ${String(pixels.byteLength)}.`,
    )
  }
  const input = Buffer.alloc(OCR_HEADER_BYTES + size)
  input.write('OCRP', 0, 'latin1')
  input[4] = 1
  input[5] = FORMAT_CODE[format]
  input.writeUInt32LE(width, 8)
  input.writeUInt32LE(height, 12)
  input.set(pixels, OCR_HEADER_BYTES)
  return input
}

/** What ocr-text.exe reported: the last line of its stderr. */
export type OcrReport =
  | { kind: 'probe'; languages: number; user: boolean }
  | {
      kind: 'ok'
      lines: number
      chars: number
      width: number
      height: number
      ms: number
      peak: number
    }
  | { kind: 'error'; step: string; code: number }

const PROBE = /^ocr-text:1 probe languages=(\d{1,3}) user=([01])\r?\n$/
const OK =
  /^ocr-text:1 ok lines=(\d{1,7}) chars=(\d{1,8}) width=(\d{1,4}) height=(\d{1,4}) ms=(\d{1,7}) peak=(\d{1,12})\r?\n$/
const ERROR = /^ocr-text:1 error=([a-z-]{1,40}) code=0x([0-9A-F]{8})\r?\n$/

/** Parses ocr-text.exe's report, its stderr's last line; null for anything else. */
export function parseOcrReport(stderr: string): OcrReport | null {
  const text = /(?:^|\n)([^\n]*\n)$/.exec(stderr)?.[1] ?? ''
  const probe = PROBE.exec(text)
  if (probe) return { kind: 'probe', languages: Number(probe[1]), user: probe[2] === '1' }
  const ok = OK.exec(text)
  if (ok) {
    const [lines, chars, width, height, ms, peak] = ok.slice(1).map(Number) as [
      number,
      number,
      number,
      number,
      number,
      number,
    ]
    return { kind: 'ok', lines, chars, width, height, ms, peak }
  }
  const error = ERROR.exec(text)
  return error ? { kind: 'error', step: error[1] ?? '', code: parseInt(error[2] ?? '', 16) } : null
}

const badOutput = (why: string): OcrError =>
  new OcrError('output', `The text recognizer returned an invalid result (${why}).`)

/** The JSON object in `stdout`, at most `maxBytes`, strictly UTF-8, with exactly `keys`. */
function jsonObject(stdout: Uint8Array, maxBytes: number, keys: readonly string[]) {
  if (stdout.byteLength > maxBytes) throw badOutput('too long')
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(stdout))
  } catch {
    throw badOutput('not JSON')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw badOutput('not an object')
  }
  const object = value as Record<string, unknown>
  const own = Object.keys(object)
  if (own.length !== keys.length || !keys.every((key) => Object.hasOwn(object, key))) {
    throw badOutput('unexpected fields')
  }
  if (object['v'] !== 1) throw badOutput('unknown version')
  return object
}

/**
 * The helper's result, checked again in main: its shape, a language tag, every box inside
 * the image that was sent, and the report agreeing with it (size, line count, and `chars`,
 * the UTF-16 length of the emitted lines' text). Throws OcrError('output').
 */
export function parseOcrOutput(
  stdout: Uint8Array,
  report: Extract<OcrReport, { kind: 'ok' }>,
  expected: { width: number; height: number; maxOutputBytes: number },
): OcrResult {
  const object = jsonObject(stdout, expected.maxOutputBytes, [
    'v',
    'lang',
    'angle',
    'width',
    'height',
    'lines',
    'truncated',
  ])
  const { lang, angle, width, height, lines, truncated } = object
  if (!validTag(lang)) throw badOutput('language')
  if (
    angle !== null &&
    (typeof angle !== 'number' || !Number.isFinite(angle) || Math.abs(angle) > 360)
  ) {
    throw badOutput('angle')
  }
  if (width !== expected.width || height !== expected.height) throw badOutput('size')
  if (report.width !== expected.width || report.height !== expected.height) {
    throw badOutput('reported size')
  }
  if (typeof truncated !== 'boolean') throw badOutput('truncated')
  if (!Array.isArray(lines) || lines.length !== report.lines) throw badOutput('line count')
  const checked: OcrLine[] = lines.map((line: unknown) => {
    if (typeof line !== 'object' || line === null || Array.isArray(line)) throw badOutput('line')
    const item = line as Record<string, unknown>
    const own = Object.keys(item)
    if (own.length !== 2 || !Object.hasOwn(item, 'box') || !Object.hasOwn(item, 'text')) {
      throw badOutput('line fields')
    }
    const { box, text } = item
    if (typeof text !== 'string') throw badOutput('line text')
    if (
      !Array.isArray(box) ||
      box.length !== 4 ||
      !box.every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 0)
    ) {
      throw badOutput('box')
    }
    const [x, y, w, h] = box as [number, number, number, number]
    if (x + w > expected.width || y + h > expected.height) throw badOutput('box outside image')
    return { text, box: { x, y, width: w, height: h } }
  })
  // The helper counts UTF-16 units (hstring::size()) of the lines it emitted, as JS does.
  const chars = checked.reduce((sum, line) => sum + line.text.length, 0)
  if (chars !== report.chars) throw badOutput('character count')
  return {
    language: lang,
    angle,
    width: expected.width,
    height: expected.height,
    lines: checked,
    truncated,
    stats: { ms: report.ms, peakBytes: report.peak },
  }
}

const PROBE_MAX_BYTES = 64 * 1024

/** The probe's JSON, checked: the installed OCR languages and the user-profile one. */
export function parseProbeOutput(
  stdout: Uint8Array,
  report: Extract<OcrReport, { kind: 'probe' }>,
): { languages: string[]; user: string | null } {
  const object = jsonObject(stdout, PROBE_MAX_BYTES, ['v', 'languages', 'user', 'max_dimension'])
  const { languages, user, max_dimension: maxDimension } = object
  if (!Array.isArray(languages) || !languages.every(validTag)) throw badOutput('languages')
  if (languages.length !== report.languages) throw badOutput('language count')
  if (user !== null && !validTag(user)) throw badOutput('user language')
  if ((user !== null) !== report.user) throw badOutput('user language report')
  if (typeof maxDimension !== 'number' || !Number.isInteger(maxDimension)) {
    throw badOutput('max dimension')
  }
  return { languages, user }
}

/** What the probe found, as the availability the app reports. */
export function availabilityFrom(probe: {
  languages: string[]
  user: string | null
}): OcrAvailability {
  if (probe.user !== null) {
    return { available: true, languages: probe.languages, userLanguage: probe.user }
  }
  return {
    available: false,
    reason: 'no-language',
    message: probe.languages.length ? ocrNoUserLanguage(probe.languages) : OCR_NO_LANGUAGE,
    languages: probe.languages,
  }
}

const hex = (code: number): string => `0x${code.toString(16).toUpperCase().padStart(8, '0')}`
/** Header problems: main encoded the image wrongly, so it is a bug, reported as such. */
const INPUT_STEPS = new Set([
  'bad-header',
  'bad-format',
  'size-mismatch',
  'input-truncated',
  'input-too-large',
])

/** A failure the helper reported (its step and exit code), as the error a caller sees. */
export function recognizeFailure(step: string, code: number, exitCode: number | null): OcrError {
  if (exitCode === 2) {
    return new OcrError(
      'no-language',
      step === 'language-not-installed'
        ? 'That language has no text recognition (OCR) installed in Windows.'
        : OCR_NO_LANGUAGE,
    )
  }
  if (exitCode === 3) {
    return new OcrError(
      'memory',
      `Recognising the text needed more memory than is allowed (${step}, ${hex(code)}).`,
    )
  }
  if (step === 'too-large') {
    return new OcrError('too-large', 'The image is too large for text recognition.')
  }
  if (INPUT_STEPS.has(step)) {
    return new OcrError('invalid-image', `The text recognizer refused the image (${step}).`)
  }
  return new OcrError('failed', `The text recognizer failed (${step}, ${hex(code)}).`)
}

export type RunFailure = 'timeout' | 'output' | 'spawn' | 'cancelled'

/** Runs the helper once: input on stdin, JSON on stdout, its report last on stderr. */
export type RunOcr = (
  file: string,
  args: string[],
  input: Uint8Array | null,
  limits: {
    timeoutMs: number
    maxOutputBytes: number
    signal?: AbortSignal
    /** Below normal priority, so the user's own work comes first. */
    lowPriority?: boolean
  },
) => Promise<
  { exitCode: number | null; stdout: Uint8Array; report: string } | { failed: RunFailure }
>

const MAX_REPORT_BYTES = 4096

/**
 * Puts a helper this process just started below normal priority (BELOW_NORMAL_PRIORITY_CLASS
 * on Windows): the parent's handle on its own child, nothing more. The helper's Job Object sets
 * no priority limit, and lowering its token's integrity does not stop its parent. Best effort:
 * a helper that already exited, or a system that refuses, runs at normal priority.
 */
function lowerPriority(pid: number): void {
  try {
    setPriority(pid, osConstants.priority.PRIORITY_BELOW_NORMAL)
  } catch {
    // Normal priority it is.
  }
}

export const runOcrHelper: RunOcr = (file, args, input, limits) =>
  new Promise((resolve) => {
    if (limits.signal?.aborted) {
      resolve({ failed: 'cancelled' })
      return
    }
    const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    if (limits.lowPriority && child.pid !== undefined) lowerPriority(child.pid)
    const out: Buffer[] = []
    let outBytes = 0
    let err = ''
    let failed: RunFailure | null = null
    let settled = false
    const stop = (why: RunFailure): void => {
      failed ??= why
      child.kill()
    }
    const onAbort = (): void => {
      stop('cancelled')
    }
    const timer = setTimeout(() => {
      stop('timeout')
    }, limits.timeoutMs)
    limits.signal?.addEventListener('abort', onAbort, { once: true })
    const settle = (result: Awaited<ReturnType<RunOcr>>): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      limits.signal?.removeEventListener('abort', onAbort)
      resolve(result)
    }
    child.on('error', () => {
      failed ??= 'spawn'
      // A process that never started emits no 'close'.
      if (child.pid === undefined) settle({ failed: 'spawn' })
      else child.kill()
    })
    child.stdout.on('data', (chunk: Buffer) => {
      outBytes += chunk.length
      if (outBytes > limits.maxOutputBytes) stop('output')
      else if (!failed) out.push(chunk)
    })
    child.stderr.setEncoding('latin1')
    child.stderr.on('data', (chunk: string) => {
      err = (err + chunk).slice(-MAX_REPORT_BYTES)
    })
    child.stdin.on('error', () => undefined)
    child.on('close', (exitCode) => {
      if (failed) settle({ failed })
      else settle({ exitCode, stdout: new Uint8Array(Buffer.concat(out)), report: err })
    })
    child.stdin.end(
      input ? Buffer.from(input.buffer, input.byteOffset, input.byteLength) : undefined,
    )
  })

export interface RecognizeOptions {
  /** Aborting it kills the helper; the promise rejects with OcrError('cancelled'). */
  signal?: AbortSignal
  /** Wall-clock limit, default 60 s. */
  timeoutMs?: number
  /** A BCP 47 tag instead of the user's profile languages. */
  language?: string
  /** Output cap, 1 KiB to 1 MiB (the default); lines past it are dropped, `truncated` set. */
  maxOutputBytes?: number
  /** Work the user is not waiting on (search): the helper runs below normal priority. */
  background?: boolean
}

/** Windows' OCR, outside the app's processes. */
export interface SystemOcr {
  /** Whether OCR can run, and the installed languages; asked once unless `refresh`. Never rejects. */
  probe(options?: { refresh?: boolean }): Promise<OcrAvailability>
  /** The image's text lines; rejects with an OcrError. */
  recognize(image: OcrImage, options?: RecognizeOptions): Promise<OcrResult>
  /** Kills every running recognition (they reject with 'cancelled'). */
  cancelAll(): void
  /** How many background recognitions may run at once (1 when not said). */
  readonly helpers?: number
  /** Whether the PC runs on battery, when no new background recognition should start. */
  onBattery?(): boolean
}

export interface SystemOcrOptions {
  platform: NodeJS.Platform
  /** The verified helper, or why there is none; called before every run. */
  findHelper: () => Promise<JobLauncher>
  run?: RunOcr
  probeTimeoutMs?: number
  /** Background recognitions at once (default 1). */
  helpers?: number
  onBattery?: () => boolean
}

/** Background OCR helpers for a PC with this many logical processors: half of them, 1 or 2. */
export const ocrHelpersFor = (cores: number): number =>
  Math.max(1, Math.min(2, Math.floor(cores / 2)))

/** The app's SystemOcr: ocr-text.exe on Windows, 'unsupported' everywhere else. */
export function createSystemOcr(options: SystemOcrOptions): SystemOcr {
  const run = options.run ?? runOcrHelper
  let probed: Promise<OcrAvailability> | null = null
  let all = new AbortController()

  const unsupported = (): OcrAvailability => ({
    available: false,
    reason: 'unsupported',
    message: OCR_NOT_WINDOWS,
    languages: [],
  })
  const unavailable = (why: string): OcrAvailability => ({
    available: false,
    reason: 'unavailable',
    message: ocrUnavailable(why),
    languages: [],
  })

  const probeOnce = async (): Promise<OcrAvailability> => {
    if (options.platform !== 'win32') return unsupported()
    const helper = await options.findHelper()
    if (!helper.ok) return unavailable(helper.reason ?? 'no helper')
    const result = await run(helper.path, ['--probe'], null, {
      timeoutMs: options.probeTimeoutMs ?? 15_000,
      maxOutputBytes: PROBE_MAX_BYTES,
    })
    if ('failed' in result)
      return unavailable(`its check ${result.failed === 'timeout' ? 'timed out' : 'failed'}`)
    const report = parseOcrReport(result.report)
    if (report?.kind === 'error') return unavailable(`it could not start: ${report.step}`)
    if (report?.kind !== 'probe' || result.exitCode !== 0) return unavailable('it did not answer')
    try {
      return availabilityFrom(parseProbeOutput(result.stdout, report))
    } catch {
      return unavailable('its answer was invalid')
    }
  }

  return {
    helpers: Math.max(1, Math.floor(options.helpers ?? 1)),
    onBattery: () => options.onBattery?.() === true,

    probe(probeOptions) {
      if (probeOptions?.refresh) probed = null
      probed ??= probeOnce().catch(() => unavailable('checking for it failed'))
      return probed
    },

    async recognize(image, recognizeOptions = {}) {
      if (options.platform !== 'win32') throw new OcrError('unsupported', OCR_NOT_WINDOWS)
      const maxOutputBytes = Math.floor(recognizeOptions.maxOutputBytes ?? OCR_MAX_OUTPUT_BYTES)
      if (!(maxOutputBytes >= OCR_MIN_OUTPUT_BYTES && maxOutputBytes <= OCR_MAX_OUTPUT_BYTES)) {
        throw new OcrError('invalid-image', `Invalid output cap ${String(maxOutputBytes)}.`)
      }
      const language = recognizeOptions.language ?? 'auto'
      if (language !== 'auto' && !validTag(language)) {
        throw new OcrError('invalid-image', `Invalid language tag ${JSON.stringify(language)}.`)
      }
      const timeoutMs = recognizeOptions.timeoutMs ?? OCR_DEFAULT_TIMEOUT_MS
      // Checked before anything runs; a copy, so the caller's buffer is never handed over.
      const input = encodeOcrInput(image)
      const signal = recognizeOptions.signal
        ? AbortSignal.any([all.signal, recognizeOptions.signal])
        : all.signal
      if (signal.aborted) throw new OcrError('cancelled', 'Text recognition was cancelled.')
      // Verified right before every run, as job-run.exe is.
      const helper = await options.findHelper()
      if (!helper.ok) {
        throw new OcrError('unavailable', ocrUnavailable(helper.reason ?? 'no helper'))
      }
      const args = [
        '--recognize',
        '--input-bytes',
        String(input.byteLength),
        '--max-memory',
        String(ocrMemoryLimit(image.width, image.height)),
        '--max-output',
        String(maxOutputBytes),
        '--lang',
        language,
      ]
      const result = await run(helper.path, args, input, {
        timeoutMs,
        maxOutputBytes,
        signal,
        ...(recognizeOptions.background ? { lowPriority: true } : {}),
      })
      if ('failed' in result) {
        switch (result.failed) {
          case 'cancelled':
            throw new OcrError('cancelled', 'Text recognition was cancelled.')
          case 'timeout':
            throw new OcrError(
              'timeout',
              `Text recognition took longer than ${String(timeoutMs / 1000)} seconds.`,
            )
          case 'output':
            throw badOutput('more output than allowed')
          case 'spawn':
            throw new OcrError('failed', 'The text recognizer could not be started.')
        }
      }
      const report = parseOcrReport(result.report)
      if (report?.kind === 'error' && result.exitCode !== 0) {
        throw recognizeFailure(report.step, report.code, result.exitCode)
      }
      if (report?.kind !== 'ok' || result.exitCode !== 0) {
        throw new OcrError(
          'failed',
          `The text recognizer stopped unexpectedly (exit ${String(result.exitCode)}).`,
        )
      }
      return parseOcrOutput(result.stdout, report, {
        width: image.width,
        height: image.height,
        maxOutputBytes,
      })
    },

    cancelAll() {
      all.abort()
      all = new AbortController()
    },
  }
}

/**
 * The OCR the app uses: the installed, pinned ocr-text.exe, outside granted folders. Search
 * runs up to two at once (half the processors), and none starts while `onBattery`.
 */
export function defaultSystemOcr(
  platform: NodeJS.Platform,
  grantedRoots: () => readonly string[],
  onBattery: () => boolean = () => false,
): SystemOcr {
  return createSystemOcr({
    platform,
    helpers: ocrHelpersFor(availableParallelism()),
    onBattery,
    findHelper: () =>
      verifyPinnedHelper(
        { resources: installedResources(), sha256: OCR_TEXT_SHA256, grantedRoots, platform },
        OCR_TEXT_PATH,
      ),
  })
}
