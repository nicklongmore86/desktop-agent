import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { JobLauncher } from '../tools/job-launcher'
import {
  createSystemOcr,
  encodeOcrInput,
  OCR_MAX_OUTPUT_BYTES,
  OCR_NO_LANGUAGE,
  OCR_NOT_WINDOWS,
  ocrMemoryLimit,
  parseOcrOutput,
  parseOcrReport,
  recognizeFailure,
  runOcrHelper,
  type OcrImage,
  type RunOcr,
} from './system-ocr'

const MIB = 1024 * 1024
const image = (width = 8, height = 4, format: OcrImage['format'] = 'bgra8'): OcrImage => ({
  width,
  height,
  format,
  pixels: new Uint8Array(width * height * (format === 'bgra8' ? 4 : 1)).fill(255),
})
const found = () => Promise.resolve({ ok: true as const, path: 'C:\\app\\helpers\\ocr-text.exe' })
const utf8 = (text: string) => new TextEncoder().encode(text)

const RESULT = {
  v: 1,
  lang: 'en-US',
  angle: 0.5,
  width: 8,
  height: 4,
  lines: [{ box: [1, 0, 6, 4], text: 'Hello "world"' }],
  truncated: false,
}
const OK_REPORT = 'ocr-text:1 ok lines=1 chars=13 width=8 height=4 ms=212 peak=41000000\n'
const okRun = (stdout: unknown = RESULT, report = OK_REPORT, exitCode: number | null = 0) => ({
  exitCode,
  stdout: utf8(typeof stdout === 'string' ? stdout : JSON.stringify(stdout)),
  report,
})
const PROBE = {
  stdout: utf8('{"v":1,"languages":["en-US","fr-FR"],"user":"en-US","max_dimension":10000}\n'),
  report: 'ocr-text:1 probe languages=2 user=1\n',
  exitCode: 0,
}

/** OCR over a fake helper that answers the probe with `probe` and a recognition with `answer`. */
function ocrWith(
  answer: Awaited<ReturnType<RunOcr>> = okRun(),
  probe: Awaited<ReturnType<RunOcr>> = PROBE,
  platform: NodeJS.Platform = 'win32',
  findHelper: () => Promise<JobLauncher> = found,
) {
  const run = vi.fn<RunOcr>((_file, args) =>
    Promise.resolve(args[0] === '--probe' ? probe : answer),
  )
  const find = vi.fn(findHelper)
  return { ocr: createSystemOcr({ platform, findHelper: find, run }), run, find }
}

describe('the OCR input', () => {
  it('is a 16-byte header and a copy of exactly the pixels', () => {
    const source = image(3, 2, 'gray8')
    source.pixels.set([1, 2, 3, 4, 5, 6])
    const input = encodeOcrInput(source)
    expect([...input.subarray(0, 16)]).toEqual([
      0x4f, 0x43, 0x52, 0x50, 1, 2, 0, 0, 3, 0, 0, 0, 2, 0, 0, 0,
    ])
    expect([...input.subarray(16)]).toEqual([1, 2, 3, 4, 5, 6])
    // A copy: changing the caller's pixels later changes nothing sent.
    source.pixels[0] = 99
    expect(input[16]).toBe(1)
    expect(encodeOcrInput(image(4096, 1)).byteLength).toBe(16 + 4096 * 4)
  })

  it('is refused before anything runs when it does not match its size or limits', () => {
    const bad: [OcrImage, string][] = [
      [image(4097, 10), 'too-large'],
      [image(10, 4097, 'gray8'), 'too-large'],
      [{ ...image(), width: 0 }, 'invalid-image'],
      [{ ...image(), height: 1.5 }, 'invalid-image'],
      [{ ...image(), pixels: new Uint8Array(8 * 4 * 4 - 1) }, 'invalid-image'],
      [{ ...image(), pixels: new Uint8Array(8 * 4 * 4 + 1) }, 'invalid-image'],
      [{ ...image(), format: 'rgb24' as never }, 'invalid-image'],
    ]
    for (const [input, code] of bad) {
      expect(() => encodeOcrInput(input)).toThrow(expect.objectContaining({ code }))
    }
  })

  it('gets a memory limit of 64 MiB + 16 B/pixel, at most 256 MiB', () => {
    expect(ocrMemoryLimit(1, 1)).toBe(64 * MIB + 16)
    expect(ocrMemoryLimit(1568, 2200)).toBe(64 * MIB + 16 * 1568 * 2200)
    expect(ocrMemoryLimit(4096, 4096)).toBe(256 * MIB)
  })
})

describe('the OCR report', () => {
  it('parses only the exact last line', () => {
    expect(parseOcrReport(OK_REPORT)).toEqual({
      kind: 'ok',
      lines: 1,
      chars: 13,
      width: 8,
      height: 4,
      ms: 212,
      peak: 41000000,
    })
    expect(parseOcrReport('noise\nocr-text:1 probe languages=0 user=0\r\n')).toEqual({
      kind: 'probe',
      languages: 0,
      user: false,
    })
    expect(parseOcrReport('ocr-text:1 error=recognize code=0x8000FFFF\n')).toEqual({
      kind: 'error',
      step: 'recognize',
      code: 0x8000ffff,
    })
    for (const text of [
      '',
      OK_REPORT.trim(),
      `${OK_REPORT}trailing`,
      'ocr-text:2 probe languages=1 user=1\n',
      'ocr-text:1 error=Recognize code=0x8000FFFF\n',
      'ocr-text:1 ok lines=1 chars=1 width=99999 height=4 ms=1 peak=1\n',
    ]) {
      expect(parseOcrReport(text)).toBeNull()
    }
  })

  it('maps exit codes and steps to errors a caller can act on', () => {
    expect(recognizeFailure('no-language', 0x80004001, 2)).toMatchObject({
      code: 'no-language',
      message: OCR_NO_LANGUAGE,
    })
    expect(recognizeFailure('language-not-installed', 0x80004001, 2).code).toBe('no-language')
    // Recognition hitting the job's memory limit fails with E_UNEXPECTED: exit 3.
    expect(recognizeFailure('recognize', 0x8000ffff, 3)).toMatchObject({
      code: 'memory',
      message: expect.stringMatching(/more memory.*recognize, 0x8000FFFF/) as string,
    })
    expect(recognizeFailure('too-large', 0x80070057, 1).code).toBe('too-large')
    expect(recognizeFailure('size-mismatch', 0x80070057, 1).code).toBe('invalid-image')
    expect(recognizeFailure('low-integrity', 0x80070005, 1)).toMatchObject({
      code: 'failed',
      message: 'The text recognizer failed (low-integrity, 0x80070005).',
    })
  })
})

describe('the OCR output, checked in main', () => {
  const expected = { width: 8, height: 4, maxOutputBytes: OCR_MAX_OUTPUT_BYTES }
  const report = parseOcrReport(OK_REPORT) as Extract<
    ReturnType<typeof parseOcrReport>,
    { kind: 'ok' }
  >
  const parse = (value: unknown, r = report, e = expected) =>
    parseOcrOutput(utf8(typeof value === 'string' ? value : JSON.stringify(value)), r, e)

  it('becomes lines with boxes in the image’s pixels', () => {
    expect(parse(RESULT)).toEqual({
      language: 'en-US',
      angle: 0.5,
      width: 8,
      height: 4,
      lines: [{ text: 'Hello "world"', box: { x: 1, y: 0, width: 6, height: 4 } }],
      truncated: false,
      stats: { ms: 212, peakBytes: 41000000 },
    })
    expect(parse({ ...RESULT, angle: null }).angle).toBeNull()
  })

  it('is refused when anything does not fit what was sent', () => {
    const line = RESULT.lines[0]
    const bad: unknown[] = [
      'not json',
      '[]',
      { ...RESULT, v: 2 },
      { ...RESULT, extra: 1 },
      { ...RESULT, lang: 'en US' },
      { ...RESULT, lang: '<script>' },
      { ...RESULT, angle: 400 },
      { ...RESULT, angle: '0' },
      { ...RESULT, width: 9 },
      { ...RESULT, truncated: 'no' },
      { ...RESULT, lines: [] },
      { ...RESULT, lines: [{ ...line, box: [3, 0, 6, 4] }] },
      { ...RESULT, lines: [{ ...line, box: [0, 1, 6, 4] }] },
      { ...RESULT, lines: [{ ...line, box: [-1, 0, 6, 4] }] },
      { ...RESULT, lines: [{ ...line, box: [0.5, 0, 6, 4] }] },
      { ...RESULT, lines: [{ ...line, box: [0, 0, 6] }] },
      { ...RESULT, lines: [{ ...line, text: 5 }] },
      { ...RESULT, lines: [{ ...line, extra: true }] },
    ]
    for (const value of bad) {
      expect(() => parse(value), JSON.stringify(value)).toThrow(
        expect.objectContaining({ code: 'output' }),
      )
    }
    // Invalid UTF-8, and more than the cap.
    expect(() => parseOcrOutput(new Uint8Array([0x7b, 0xff, 0x7d]), report, expected)).toThrow(
      expect.objectContaining({ code: 'output' }),
    )
    expect(() => parse(RESULT, report, { ...expected, maxOutputBytes: 64 })).toThrow(
      expect.objectContaining({ code: 'output' }),
    )
    // The report must agree with the JSON.
    expect(() => parse(RESULT, { ...report, lines: 2 })).toThrow(
      expect.objectContaining({ code: 'output' }),
    )
    expect(() => parse(RESULT, { ...report, width: 7 })).toThrow(
      expect.objectContaining({ code: 'output' }),
    )
  })

  const withLines = (texts: string[], truncated = false) => ({
    ...RESULT,
    lines: texts.map((text) => ({ box: [0, 0, 8, 4], text })),
    truncated,
  })
  const counted = (lines: number, chars: number) => ({ ...report, lines, chars })

  it('is refused when the report’s character count does not match the text', () => {
    for (const chars of [0, 12, 14, 26]) {
      expect(() => parse(RESULT, counted(1, chars)), String(chars)).toThrow(
        'invalid result (character count)',
      )
    }
    expect(parse(RESULT, counted(1, 13)).lines).toHaveLength(1)
    expect(parse(withLines(['ab', '', 'cde']), counted(3, 5)).lines).toHaveLength(3)
    expect(parse(withLines([]), counted(0, 0)).lines).toEqual([])
  })

  it('counts characters only in the lines emitted when truncated', () => {
    const value = withLines(['first line', 'second'], true)
    expect(parse(value, counted(2, 16)).truncated).toBe(true)
    // A count that includes a dropped line is refused.
    expect(() => parse(value, counted(2, 16 + 'dropped third line'.length))).toThrow(
      expect.objectContaining({ code: 'output' }),
    )
  })

  it('counts characters in UTF-16 units, as the helper’s hstring::size() does', () => {
    // 'é' precomposed is 1 unit, 'e' + U+0301 is 2, U+1D400 (astral) and an emoji are 2 each.
    const texts = ['caf\u00e9', 'cafe\u0301', '\u{1D400}x', 'ok \u{1F600}']
    const units = [4, 5, 3, 5]
    expect(texts.map((t) => t.length)).toEqual(units)
    const sum = units.reduce((a, b) => a + b, 0)
    expect(parse(withLines(texts), counted(4, sum)).lines.map((l) => l.text)).toEqual(texts)
    // Code points (or UTF-8 bytes) would be a different number, and are refused.
    const codePoints = texts.reduce((n, t) => n + Array.from(t).length, 0)
    const bytes = texts.reduce((n, t) => n + utf8(t).length, 0)
    expect(new Set([sum, codePoints, bytes]).size).toBe(3)
    for (const wrong of [codePoints, bytes]) {
      expect(() => parse(withLines(texts), counted(4, wrong))).toThrow(
        expect.objectContaining({ code: 'output' }),
      )
    }
  })

  it('reads the helper’s escaping back exactly', () => {
    // As json_string writes them: quote, backslash and C0 controls and DEL escaped, the rest raw UTF-8.
    const raw =
      '{"v":1,"lang":"en-US","angle":null,"width":8,"height":4,"lines":[' +
      '{"box":[0,0,8,4],"text":"a\\"b\\\\c\\u0009d\\u000a\\u001f\\u007f"},' +
      '{"box":[0,0,8,4],"text":"\u00e9\u4e2d\u{1F600}"}],"truncated":false}\n'
    const want = ['a"b\\c\td\n\u001f\u007f', '\u00e9\u4e2d\u{1F600}']
    const chars = want.reduce((n, t) => n + t.length, 0)
    expect(parse(raw, counted(2, chars)).lines.map((l) => l.text)).toEqual(want)
  })
})

describe('the system OCR', () => {
  it('is unsupported off Windows, and never runs or looks for anything there', async () => {
    const { ocr, run, find } = ocrWith(undefined, undefined, 'linux')
    await expect(ocr.probe()).resolves.toEqual({
      available: false,
      reason: 'unsupported',
      message: OCR_NOT_WINDOWS,
      languages: [],
    })
    await expect(ocr.recognize(image())).rejects.toMatchObject({
      code: 'unsupported',
      message: OCR_NOT_WINDOWS,
    })
    expect(run).not.toHaveBeenCalled()
    expect(find).not.toHaveBeenCalled()
  })

  it('probes once for the installed languages, again when asked to refresh', async () => {
    const { ocr, run } = ocrWith()
    const available = { available: true, languages: ['en-US', 'fr-FR'], userLanguage: 'en-US' }
    await expect(ocr.probe()).resolves.toEqual(available)
    await expect(ocr.probe()).resolves.toEqual(available)
    expect(run).toHaveBeenCalledTimes(1)
    await ocr.probe({ refresh: true })
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('says when no OCR language is installed, or none of the user’s', async () => {
    const none = ocrWith(undefined, {
      stdout: utf8('{"v":1,"languages":[],"user":null,"max_dimension":10000}'),
      report: 'ocr-text:1 probe languages=0 user=0\n',
      exitCode: 0,
    }).ocr
    await expect(none.probe()).resolves.toEqual({
      available: false,
      reason: 'no-language',
      message: OCR_NO_LANGUAGE,
      languages: [],
    })
    const other = ocrWith(undefined, {
      stdout: utf8('{"v":1,"languages":["ja-JP"],"user":null,"max_dimension":10000}'),
      report: 'ocr-text:1 probe languages=1 user=0\n',
      exitCode: 0,
    }).ocr
    await expect(other.probe()).resolves.toMatchObject({
      available: false,
      reason: 'no-language',
      message: expect.stringContaining('installed for ja-JP') as string,
      languages: ['ja-JP'],
    })
  })

  it('reports the helper unavailable when it fails its check, answers wrongly or not at all', async () => {
    const tampered = ocrWith(undefined, undefined, 'win32', () =>
      Promise.resolve({ ok: false, reason: 'ocr-text.exe failed its integrity check' }),
    )
    await expect(tampered.ocr.probe()).resolves.toMatchObject({
      available: false,
      reason: 'unavailable',
      message: expect.stringContaining('integrity check') as string,
    })
    await expect(tampered.ocr.recognize(image())).rejects.toMatchObject({
      code: 'unavailable',
      message: expect.stringContaining('integrity check') as string,
    })
    expect(tampered.run).not.toHaveBeenCalled()

    const answers: Awaited<ReturnType<RunOcr>>[] = [
      { failed: 'timeout' },
      { exitCode: 1, stdout: new Uint8Array(), report: 'ocr-text:1 error=job code=0x80070005\n' },
      { ...PROBE, exitCode: 1 },
      { ...PROBE, report: 'ocr-text:1 probe languages=3 user=1\n' },
      { ...PROBE, stdout: utf8('{"v":1,"languages":["en US"],"user":null,"max_dimension":1}') },
    ]
    for (const answer of answers) {
      await expect(ocrWith(undefined, answer).ocr.probe()).resolves.toMatchObject({
        available: false,
        reason: 'unavailable',
      })
    }
  })

  it('verifies the helper before every run and passes the limits', async () => {
    const { ocr, run, find } = ocrWith()
    const picture = image()
    await expect(ocr.recognize(picture)).resolves.toMatchObject({ language: 'en-US' })
    await ocr.recognize(picture, { language: 'fr-FR', maxOutputBytes: 4096, timeoutMs: 5000 })
    expect(find).toHaveBeenCalledTimes(2)
    const [file, args, input, limits] = run.mock.calls[1] ?? []
    expect(file).toBe('C:\\app\\helpers\\ocr-text.exe')
    expect(args).toEqual([
      '--recognize',
      '--input-bytes',
      String(16 + 8 * 4 * 4),
      '--max-memory',
      String(64 * MIB + 16 * 32),
      '--max-output',
      '4096',
      '--lang',
      'fr-FR',
    ])
    expect(input?.byteLength).toBe(16 + 8 * 4 * 4)
    expect(limits).toMatchObject({ timeoutMs: 5000, maxOutputBytes: 4096 })
  })

  it('refuses bad options and images without running anything', async () => {
    const { ocr, run } = ocrWith()
    await expect(ocr.recognize(image(), { language: 'en US' })).rejects.toMatchObject({
      code: 'invalid-image',
    })
    await expect(ocr.recognize(image(), { maxOutputBytes: 100 })).rejects.toMatchObject({
      code: 'invalid-image',
    })
    await expect(ocr.recognize(image(), { maxOutputBytes: 2 * MIB })).rejects.toMatchObject({
      code: 'invalid-image',
    })
    await expect(ocr.recognize(image(5000, 10))).rejects.toMatchObject({ code: 'too-large' })
    const aborted = new AbortController()
    aborted.abort()
    await expect(ocr.recognize(image(), { signal: aborted.signal })).rejects.toMatchObject({
      code: 'cancelled',
    })
    expect(run).not.toHaveBeenCalled()
  })

  it('turns every way a run can fail into an OcrError', async () => {
    const cases: [Awaited<ReturnType<RunOcr>>, string][] = [
      [{ failed: 'timeout' }, 'timeout'],
      [{ failed: 'cancelled' }, 'cancelled'],
      [{ failed: 'output' }, 'output'],
      [{ failed: 'spawn' }, 'failed'],
      [okRun('', 'ocr-text:1 error=no-language code=0x80004001\n', 2), 'no-language'],
      [okRun('', 'ocr-text:1 error=recognize code=0x8000FFFF\n', 3), 'memory'],
      [okRun('', 'ocr-text:1 error=too-large code=0x80070057\n', 1), 'too-large'],
      // Killed by its job (CPU time) or crashed: no report.
      [okRun('', '', 1816), 'failed'],
      [okRun('', '', null), 'failed'],
      // A report that disagrees with the exit code.
      [okRun(RESULT, OK_REPORT, 1), 'failed'],
      [okRun('', 'ocr-text:1 error=recognize code=0x8000FFFF\n', 0), 'failed'],
      // Output that does not check out.
      [okRun({ ...RESULT, width: 99 }), 'output'],
      [okRun('{"v":1,', OK_REPORT), 'output'],
    ]
    for (const [answer, code] of cases) {
      await expect(
        ocrWith(answer).ocr.recognize(image()),
        JSON.stringify(answer),
      ).rejects.toMatchObject({ code })
    }
  })
})

/**
 * A stand-in for ocr-text.exe, run with Node through the real runOcrHelper: it reads its
 * stdin, then behaves as its first argument says.
 */
const FAKE = `
const mode = process.argv[2]
const chunks = []
process.stdin.on('data', (c) => chunks.push(c))
process.stdin.on('end', () => {
  const input = Buffer.concat(chunks)
  if (mode === 'ok') {
    const width = input.readUInt32LE(8), height = input.readUInt32LE(12)
    process.stdout.write(JSON.stringify({ v: 1, lang: 'en-US', angle: null, width, height,
      lines: [{ box: [0, 0, width, height], text: 'bytes=' + input.length }], truncated: false }))
    process.stderr.write('codec noise\\nocr-text:1 ok lines=1 chars=' +
      ('bytes=' + input.length).length + ' width=' + width +
      ' height=' + height + ' ms=5 peak=1000\\n')
  } else if (mode === 'flood') {
    process.stdout.write(Buffer.alloc(2 * 1024 * 1024, 0x20))
  } else if (mode === 'hang') {
    setInterval(() => {}, 1000)
  }
})
`

describe('runOcrHelper, with a real process', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ocr-fake-'))
  const script = join(dir, 'fake-ocr.cjs')
  writeFileSync(script, FAKE)
  const ocrRunning = (mode: string) =>
    createSystemOcr({
      platform: 'win32',
      findHelper: found,
      run: (_file, _args, input, limits) =>
        runOcrHelper(process.execPath, [script, mode], input, limits),
    })

  it('sends the pixels and reads the result back', async () => {
    const result = await ocrRunning('ok').recognize(image(16, 8))
    expect(result.lines).toEqual([
      { text: `bytes=${String(16 + 16 * 8 * 4)}`, box: { x: 0, y: 0, width: 16, height: 8 } },
    ])
  })

  it('kills a helper that writes more than the cap', async () => {
    await expect(ocrRunning('flood').recognize(image())).rejects.toMatchObject({ code: 'output' })
  })

  it('kills a helper at the deadline', async () => {
    const started = Date.now()
    await expect(ocrRunning('hang').recognize(image(), { timeoutMs: 300 })).rejects.toMatchObject({
      code: 'timeout',
    })
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('kills a helper when cancelled, by its signal or cancelAll', async () => {
    const ocr = ocrRunning('hang')
    const controller = new AbortController()
    const one = ocr.recognize(image(), { signal: controller.signal })
    setTimeout(() => {
      controller.abort()
    }, 200)
    await expect(one).rejects.toMatchObject({ code: 'cancelled' })

    const two = ocr.recognize(image())
    setTimeout(() => {
      ocr.cancelAll()
    }, 200)
    await expect(two).rejects.toMatchObject({ code: 'cancelled' })
    // Later runs are not cancelled by the earlier cancelAll.
    await expect(ocrRunning('ok').recognize(image())).resolves.toBeTruthy()
  })

  it('reports a helper that cannot start', async () => {
    const ocr = createSystemOcr({
      platform: 'win32',
      findHelper: found,
      run: (_file, args, input, limits) =>
        runOcrHelper(join(dir, 'missing.exe'), args, input, limits),
    })
    await expect(ocr.recognize(image())).rejects.toMatchObject({ code: 'failed' })
  })
})
