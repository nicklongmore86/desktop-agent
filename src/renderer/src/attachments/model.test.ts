import { describe, expect, it } from 'vitest'
import { ATTACHMENT_LIMITS, type AttachmentRef } from '../../../shared/attachments'
import type { AttachErrorCode } from '../../../shared/ipc-attachments'
import {
  admit,
  canReceive,
  formatSize,
  middleTruncate,
  NO_VISION,
  NOT_SENT_YET,
  notReceivedNote,
  refusalMessage,
  sortOutcomes,
  summarizeRefusals,
  TOO_MANY_FILES,
  TOO_MUCH_DATA,
  type StagedAttachment,
} from './model'

const ref = (n: number, size = 10, extra: Partial<AttachmentRef> = {}): StagedAttachment => ({
  attachment: {
    id: n.toString(16).padStart(64, '0'),
    name: `f${String(n)}.txt`,
    kind: 'text',
    mime: 'text/plain',
    size,
    ...extra,
  },
  outsideGrant: false,
})

describe('chip text', () => {
  it('cuts the middle of a long name and keeps the extension', () => {
    const name = 'quarterly-financial-summary-final-v2.xlsx'
    const short = middleTruncate(name, 24)
    expect(Array.from(short)).toHaveLength(24)
    expect(short.startsWith('quarterly-')).toBe(true)
    expect(short.endsWith('v2.xlsx')).toBe(true)
    expect(short).toContain('…')
    expect(middleTruncate('a.txt')).toBe('a.txt')
  })

  it('never splits a surrogate pair and leaves bidi text to the isolating element', () => {
    const emoji = `${'😀'.repeat(40)}.png`
    const short = middleTruncate(emoji, 20)
    expect(Array.from(short)).toHaveLength(20)
    expect(short).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/)
    // Right-to-left names are truncated by character, not reordered.
    const hebrew = `${'ש'.repeat(50)}.txt`
    expect(middleTruncate(hebrew, 20).endsWith('.txt')).toBe(true)
  })

  it('formats sizes', () => {
    expect(formatSize(0)).toBe('0 B')
    expect(formatSize(1023)).toBe('1023 B')
    expect(formatSize(1536)).toBe('1.5 KB')
    expect(formatSize(20 * 1024 * 1024)).toBe('20 MB')
  })

  it('says text files, PDFs and Office documents always reach the model, and images only a vision model', () => {
    const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    expect(canReceive('text')).toBe(true)
    expect(canReceive('pdf')).toBe(true)
    expect(canReceive('pdf', true)).toBe(true)
    expect(canReceive('image')).toBe(false)
    expect(canReceive('image', true)).toBe(true)
    expect(canReceive('document', false, docx)).toBe(true)
    expect(canReceive('document', false, 'application/vnd.ms-excel')).toBe(true)
    expect(canReceive('document', false, 'application/vnd.oasis.opendocument.spreadsheet')).toBe(
      true,
    )
    // Older PowerPoint, RTF and mail are still sent as names.
    expect(canReceive('document', true, 'application/vnd.ms-powerpoint')).toBe(false)
    expect(canReceive('document', true, 'application/rtf')).toBe(false)
    expect(canReceive('document', true)).toBe(false)
    expect(notReceivedNote('image')).toBe(NO_VISION)
    expect(notReceivedNote('pdf')).toBeUndefined()
    expect(notReceivedNote('document', false, docx)).toBeUndefined()
    expect(notReceivedNote('document', true, 'application/rtf')).toBe(NOT_SENT_YET)
    expect(notReceivedNote('image', true)).toBeUndefined()
  })
})

describe('per-message limits', () => {
  it('stops at 10 files', () => {
    const first = Array.from({ length: 8 }, (_, i) => ref(i + 1))
    const result = admit(first, [ref(20), ref(21), ref(22), ref(23)])
    expect(result.staged).toHaveLength(ATTACHMENT_LIMITS.maxPerMessage)
    expect(result.refusals).toEqual([TOO_MANY_FILES, TOO_MANY_FILES])
  })

  it('stops at 20 MB in all, without letting a later small file jump the queue wrongly', () => {
    const mb = 1024 * 1024
    const result = admit([ref(1, 15 * mb)], [ref(2, 6 * mb), ref(3, 4 * mb)])
    expect(result.staged.map((s) => s.attachment.size)).toEqual([15 * mb, 4 * mb])
    expect(result.refusals).toEqual([TOO_MUCH_DATA])
    expect(TOO_MUCH_DATA).toContain('20 MB')
  })

  it('skips a file that is already staged (same content, same id)', () => {
    const result = admit([ref(1)], [ref(1, 10, { name: 'again.txt' })])
    expect(result.staged).toHaveLength(1)
    expect(result.refusals).toEqual([])
  })
})

describe('refusals', () => {
  const codes: AttachErrorCode[] = [
    'secret',
    'blocked',
    'too-large',
    'binary',
    'link',
    'not-found',
    'invalid',
    'grant-folder',
    'too-many',
    'failed',
  ]
  it.each(codes)('has a clear message for %s', (code) => {
    const message = refusalMessage(code, '', 'a.bin')
    expect(message.length).toBeGreaterThan(10)
    expect(message).not.toContain('undefined')
  })

  it('points a folder outside the grants to Settings → Folders', () => {
    expect(refusalMessage('grant-folder', '')).toContain('Settings → Folders')
  })

  it('prefers the reason main gave for secrets, size and type', () => {
    expect(refusalMessage('secret', 'Secret files are never attached.')).toBe(
      'Secret files are never attached.',
    )
    expect(refusalMessage('too-large', 'a.txt is over 256 KB.')).toBe('a.txt is over 256 KB.')
  })

  it('sorts outcomes into chips, references and refusals', () => {
    const attachment = ref(1).attachment
    const sorted = sortOutcomes(
      [
        { ok: true, kind: 'reference', text: '@"C:\\p\\a.md"' },
        { ok: true, kind: 'attachment', attachment, outsideGrant: true },
        { ok: false, code: 'secret', reason: 'Nope.' },
      ],
      ['a.md', 'f1.txt', '.env'],
    )
    expect(sorted.references).toEqual(['@"C:\\p\\a.md"'])
    expect(sorted.attachments).toEqual([{ attachment, outsideGrant: true }])
    expect(sorted.refusals).toEqual([{ code: 'secret', message: 'Nope.' }])
  })

  it('combines several refusals into one line', () => {
    expect(summarizeRefusals([])).toBeNull()
    expect(summarizeRefusals(['A', 'A'])).toBe('A')
    expect(summarizeRefusals(['A', 'B', 'C'])).toBe('A (and 2 more not attached)')
  })
})
