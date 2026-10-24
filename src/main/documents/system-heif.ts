// HEIC photos, decoded with Windows' own codecs through heif-decode.exe (native/heif-decode):
// no HEVC decoder is bundled. See docs/document-reader.md, "HEIC photos".
import { spawn } from 'node:child_process'
import { installedResources, verifyPinnedHelper, type JobLauncher } from '../tools/job-launcher'
import type { HeicSupport } from '../../shared/attachments'
import { DocumentError, type DocumentErrorCode } from './types'

export type { HeicSupport }

/**
 * The decoder's SHA-256, compiled in at build time from the build's pins file as the
 * marker `heif-decode.exe-sha256:<digest>` (see scripts/job-helper.mjs); undefined in a
 * build without it and in tests.
 */
declare const __HEIF_DECODE_PIN__: string | undefined

export const HEIF_DECODE_SHA256: string | null =
  (typeof __HEIF_DECODE_PIN__ === 'string' &&
    /^heif-decode\.exe-sha256:([0-9a-f]{64})$/.exec(__HEIF_DECODE_PIN__)?.[1]) ||
  null

/** Where the installer puts the decoder, relative to the app's resources folder. */
export const HEIF_DECODE_PATH = ['helpers', 'heif-decode.exe'] as const

export interface SystemDecodeOptions {
  /** Long edge of the PNG, at most. */
  longEdge: number
  /** Refused above this, from the size the codec reports, before any pixel is decoded. */
  maxPixels: number
  maxInputBytes: number
  /** The decoder's own memory ceiling (a Job Object limit). */
  memoryBytes: number
  timeoutMs: number
  /** Largest PNG accepted back. */
  maxOutputBytes: number
}

/** Decodes HEIC photos outside the app's processes; the document host's view of it. */
export interface SystemImageDecoder {
  /** Asked once per session (later calls share the answer); never rejects. */
  support(): Promise<HeicSupport>
  /** A PNG of the photo, upright or as stored; rejects with a DocumentError. */
  decode(bytes: Uint8Array, options: SystemDecodeOptions): Promise<Uint8Array>
}

export const HEIC_NOT_WINDOWS =
  'This photo is HEIC, which this app can decode only on Windows (with Microsoft’s HEIF and HEVC codecs). Export it as JPEG or PNG and try again.'
export const HEIC_NO_CODEC =
  'This photo is HEIC. Install “HEIF Image Extensions” and “HEVC Video Extensions” from the Microsoft Store, or export it as JPEG, and try again.'
export const HEIC_NO_HEVC =
  'This photo is HEIC. Install “HEVC Video Extensions” from the Microsoft Store (HEIF Image Extensions is already installed), or export it as JPEG, and try again.'
export const HEIC_NO_HEIF =
  'This photo is HEIC. Install “HEIF Image Extensions” from the Microsoft Store, or export it as JPEG, and try again.'
const heicUnavailable = (why: string): string =>
  `This photo is HEIC, and the app’s HEIC decoder is not available (${why}). Export it as JPEG and try again.`

/** What heif-decode.exe reported on stderr: exactly one line. */
export type DecoderReport =
  | { kind: 'probe'; heif: boolean; hevc: boolean }
  | { kind: 'ok'; width: number; height: number }
  | { kind: 'error'; step: string; code: number }

const PROBE = /^heif-decode:1 probe heif=([01]) hevc=([01])\r?\n$/
const OK = /^heif-decode:1 ok width=(\d{1,5}) height=(\d{1,5})\r?\n$/
const ERROR = /^heif-decode:1 error=([a-z-]{1,40}) code=0x([0-9A-F]{8})\r?\n$/

/** Parses heif-decode.exe's report; null for anything else. */
export function parseDecoderReport(text: string): DecoderReport | null {
  const probe = PROBE.exec(text)
  if (probe) return { kind: 'probe', heif: probe[1] === '1', hevc: probe[2] === '1' }
  const ok = OK.exec(text)
  if (ok) return { kind: 'ok', width: Number(ok[1]), height: Number(ok[2]) }
  const error = ERROR.exec(text)
  return error ? { kind: 'error', step: error[1] ?? '', code: parseInt(error[2] ?? '', 16) } : null
}

/** What the probe found, as the support the app reports. */
export function supportFrom(probe: { heif: boolean; hevc: boolean }): HeicSupport {
  if (probe.heif && probe.hevc) return { supported: true }
  if (probe.heif) return { supported: false, reason: HEIC_NO_HEVC }
  if (probe.hevc) return { supported: false, reason: HEIC_NO_HEIF }
  return { supported: false, reason: HEIC_NO_CODEC }
}

/** HRESULTs a missing codec is known to fail with, at the decode step. */
const CODEC_MISSING = new Set([
  0x88982f50, // WINCODEC_ERR_COMPONENTNOTFOUND
  0x80040154, // REGDB_E_CLASSNOTREG
  0xc00d5212, // MF_E_TOPO_CODEC_NOT_FOUND
])
const OUT_OF_MEMORY = new Set([0x8007000e, 0x80070008]) // E_OUTOFMEMORY, ERROR_NOT_ENOUGH_MEMORY
const hex = (code: number): string => `0x${code.toString(16).toUpperCase().padStart(8, '0')}`

/** A decode failure the decoder reported, as the error a caller sees. */
export function decodeFailure(step: string, code: number): DocumentError {
  const fail = (kind: DocumentErrorCode, message: string): DocumentError =>
    new DocumentError(kind, message)
  if (step === 'too-many-pixels') {
    return fail('too-many-pixels', 'The photo is larger than the 100 megapixels that can be read.')
  }
  if (step === 'input-too-large') return fail('too-large', 'The photo is too large to read.')
  if (step === 'no-decoder' || (step === 'decode' && CODEC_MISSING.has(code))) {
    return fail('unsupported', HEIC_NO_CODEC)
  }
  if (OUT_OF_MEMORY.has(code)) {
    return fail('memory', 'Decoding the photo needed more memory than is allowed.')
  }
  if (['open', 'frame', 'size', 'decode', 'scale', 'convert'].includes(step)) {
    return fail(
      'malformed',
      `Windows’ HEIF codec could not decode this photo (${step} failed, ${hex(code)}); it may be damaged. Export it as JPEG and try again.`,
    )
  }
  return fail('worker-failed', `The HEIC decoder failed (${step}, ${hex(code)}).`)
}

/** Runs the decoder once: bytes in on stdin, a PNG out on stdout, one report line on stderr. */
export type RunDecoder = (
  file: string,
  args: string[],
  input: Uint8Array | null,
  limits: { timeoutMs: number; maxOutputBytes: number },
) => Promise<{ stdout: Uint8Array; report: string } | { failed: 'timeout' | 'output' | 'spawn' }>

const MAX_REPORT_BYTES = 4096

export const runDecoder: RunDecoder = (file, args, input, limits) =>
  new Promise((resolve) => {
    const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    const out: Buffer[] = []
    let outBytes = 0
    let err = ''
    let failed: 'timeout' | 'output' | 'spawn' | null = null
    const stop = (why: 'timeout' | 'output' | 'spawn'): void => {
      failed ??= why
      child.kill()
    }
    const timer = setTimeout(() => {
      stop('timeout')
    }, limits.timeoutMs)
    child.on('error', () => {
      stop('spawn')
    })
    child.stdout.on('data', (chunk: Buffer) => {
      outBytes += chunk.length
      if (outBytes > limits.maxOutputBytes) stop('output')
      else out.push(chunk)
    })
    child.stderr.setEncoding('latin1')
    child.stderr.on('data', (chunk: string) => {
      if (err.length < MAX_REPORT_BYTES) err += chunk.slice(0, MAX_REPORT_BYTES - err.length)
    })
    child.stdin.on('error', () => undefined)
    child.on('close', () => {
      clearTimeout(timer)
      if (failed) resolve({ failed })
      else resolve({ stdout: new Uint8Array(Buffer.concat(out)), report: err })
    })
    child.stdin.end(
      input ? Buffer.from(input.buffer, input.byteOffset, input.byteLength) : undefined,
    )
  })

export interface SystemHeifOptions {
  platform: NodeJS.Platform
  /** The verified decoder, or why there is none. */
  findDecoder: () => Promise<JobLauncher>
  run?: RunDecoder
  probeTimeoutMs?: number
  /** Called once with what the probe found (for the log). */
  onSupport?: (support: HeicSupport) => void
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** The app's SystemImageDecoder: heif-decode.exe on Windows, nothing elsewhere. */
export function createSystemHeifDecoder(options: SystemHeifOptions): SystemImageDecoder {
  const run = options.run ?? runDecoder
  let support: Promise<HeicSupport> | null = null

  const probe = async (): Promise<HeicSupport> => {
    if (options.platform !== 'win32') return { supported: false, reason: HEIC_NOT_WINDOWS }
    const decoder = await options.findDecoder()
    if (!decoder.ok) return { supported: false, reason: heicUnavailable(decoder.reason ?? 'none') }
    const result = await run(decoder.path, ['--probe'], null, {
      timeoutMs: options.probeTimeoutMs ?? 10_000,
      maxOutputBytes: 0,
    })
    const report = 'report' in result ? parseDecoderReport(result.report) : null
    if (report?.kind === 'probe') return supportFrom(report)
    if (report?.kind === 'error') {
      return { supported: false, reason: heicUnavailable(`it could not start: ${report.step}`) }
    }
    return { supported: false, reason: heicUnavailable('it did not answer') }
  }

  const supported = (): Promise<HeicSupport> => {
    support ??= probe()
      .catch((): HeicSupport => ({
        supported: false,
        reason: heicUnavailable('checking for it failed'),
      }))
      .then((found) => {
        options.onSupport?.(found)
        return found
      })
    return support
  }

  return {
    support: supported,
    async decode(bytes, limits) {
      const known = await supported()
      if (!known.supported) throw new DocumentError('unsupported', known.reason)
      // Checked again right before it runs, as job-run.exe is.
      const decoder = await options.findDecoder()
      if (!decoder.ok) {
        throw new DocumentError('unsupported', heicUnavailable(decoder.reason ?? 'none'))
      }
      const args = [
        '--decode',
        '--format',
        'heif',
        '--long-edge',
        String(Math.floor(limits.longEdge)),
        '--max-pixels',
        String(Math.floor(limits.maxPixels)),
        '--max-input',
        String(Math.floor(limits.maxInputBytes)),
        '--max-memory',
        String(Math.floor(limits.memoryBytes)),
      ]
      const result = await run(decoder.path, args, bytes, limits)
      if ('failed' in result) {
        if (result.failed === 'timeout') {
          throw new DocumentError(
            'timeout',
            `Decoding the photo took longer than ${String(limits.timeoutMs / 1000)} seconds.`,
          )
        }
        throw new DocumentError(
          'worker-failed',
          result.failed === 'output'
            ? 'The HEIC decoder returned more data than allowed.'
            : 'The HEIC decoder could not be started.',
        )
      }
      const report = parseDecoderReport(result.report)
      if (report?.kind === 'error') throw decodeFailure(report.step, report.code)
      const { stdout } = result
      // Only a first look: the worker decodes and re-encodes it, and the reply is checked.
      if (
        report?.kind !== 'ok' ||
        report.width > limits.longEdge ||
        report.height > limits.longEdge ||
        !PNG_SIGNATURE.every((byte, i) => stdout[i] === byte)
      ) {
        throw new DocumentError('worker-failed', 'The HEIC decoder stopped unexpectedly.')
      }
      return stdout
    },
  }
}

/** The decoder the app uses: the installed, pinned heif-decode.exe, outside granted folders. */
export function defaultSystemHeifDecoder(
  platform: NodeJS.Platform,
  grantedRoots: () => readonly string[],
): SystemImageDecoder {
  return createSystemHeifDecoder({
    platform,
    findDecoder: () =>
      verifyPinnedHelper(
        { resources: installedResources(), sha256: HEIF_DECODE_SHA256, grantedRoots, platform },
        HEIF_DECODE_PATH,
      ),
    onSupport: (support) => {
      if (!support.supported && platform === 'win32') {
        console.warn(`read_document: HEIC photos cannot be decoded: ${support.reason}`)
      }
    },
  })
}
