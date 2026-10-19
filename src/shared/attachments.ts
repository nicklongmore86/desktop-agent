/** A user-provided attachment, held by the main process. The renderer only ever sees this metadata. */
export type AttachmentKind = 'text' | 'image' | 'pdf'

export interface AttachmentRef {
  /** Opaque id issued by the main process (lowercase hex sha256 of the stored bytes). */
  id: string
  /** Display name, already made safe for the UI by the main process. */
  name: string
  kind: AttachmentKind
  mime: string
  size: number
}

export const ATTACHMENT_LIMITS = {
  maxPerMessage: 10,
  textBytes: 256 * 1024,
  imageBytes: 5 * 1024 * 1024,
  imageMaxSide: 1568,
  pdfBytes: 10 * 1024 * 1024,
  pdfMaxPages: 100,
  messageBytes: 20 * 1024 * 1024,
} as const

export const ATTACHMENT_ID_PATTERN = /^[0-9a-f]{64}$/
