/** A user-provided attachment, held by the main process. The renderer only ever sees this metadata. */
export type AttachmentKind = 'text' | 'image' | 'pdf' | 'document'

/** Image formats that can be sent to a model as-is. Other images (HEIC, TIFF, BMP, ...) are kind 'document' and must be converted first. */
export const MODEL_IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const

/**
 * Documents (kind 'document') the document reader turns into text for every model: Word,
 * Excel, PowerPoint and OpenDocument files, and Word and Excel 97-2003. The MIME types are
 * the ones the attachment classifier records. Older PowerPoint, RTF, mail and the other
 * documents are still sent as their names only.
 */
export const READABLE_DOCUMENT_MIMES: ReadonlySet<string> = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
  'application/msword',
  'application/vnd.ms-excel',
])

export interface AttachmentSource {
  /** Id of the original attachment this one was derived from (e.g. a rendered PDF page). */
  id: string
  page?: number
  region?: { x: number; y: number; width: number; height: number }
}

export interface AttachmentRef {
  /** Opaque id issued by the main process (lowercase hex sha256 of the stored bytes). */
  id: string
  /** Display name, already made safe for the UI by the main process. */
  name: string
  kind: AttachmentKind
  mime: string
  size: number
  /** Present when this attachment was derived from another one. */
  source?: AttachmentSource
}

export const ATTACHMENT_LIMITS = {
  maxPerMessage: 10,
  textBytes: 256 * 1024,
  imageBytes: 5 * 1024 * 1024,
  /** Default long edge for images sent to models; providers may use a model-specific value. */
  imageMaxSide: 1568,
  pdfBytes: 10 * 1024 * 1024,
  pdfMaxPages: 100,
  documentBytes: 50 * 1024 * 1024,
  messageBytes: 20 * 1024 * 1024,
} as const

export const ATTACHMENT_ID_PATTERN = /^[0-9a-f]{64}$/
