import { z } from 'zod'
import { ATTACHMENT_ID_PATTERN, type HeicSupport } from '../shared/attachments'
import {
  ATTACHMENT_MAX_MIME,
  ATTACHMENT_MAX_NAME,
  ATTACHMENT_MAX_PATH,
  ATTACHMENT_PASTE_MAX_BYTES,
  attachmentsChannels,
  type AttachOutcome,
  type CopyIntoFolderResult,
} from '../shared/ipc-attachments'
import { FILES_MAX_REL, type FileLocation } from '../shared/ipc-files'
import { ROOT_ID } from './files/location'
import type { IpcHandle } from './ipc-features'

export interface AttachmentsService {
  /** A path the preload read from a dropped or pasted File; checked like any untrusted path. */
  attachDropped: (path: string) => Promise<AttachOutcome>
  pick: () => Promise<AttachOutcome[]>
  fromPaste: (bytes: Uint8Array, mime: string, name?: string) => Promise<AttachOutcome>
  copyIntoFolder: (id: string, folder: FileLocation) => Promise<CopyIntoFolderResult>
  heicSupport: () => Promise<HeicSupport>
}

// The path is checked in full by the service (checkSource); here only its type and length.
const pathSchema = z.string().max(ATTACHMENT_MAX_PATH)
const mimeSchema = z
  .string()
  .max(ATTACHMENT_MAX_MIME)
  .regex(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i)
const nameSchema = z.string().min(1).max(ATTACHMENT_MAX_NAME).optional()
const idSchema = z.string().regex(ATTACHMENT_ID_PATTERN)
const locationSchema = z.strictObject({
  rootId: z.string().regex(ROOT_ID),
  rel: z.string().max(FILES_MAX_REL),
})

export function registerAttachmentsHandlers(
  handle: IpcHandle,
  attachments: AttachmentsService,
): void {
  handle(attachmentsChannels.attachmentsAttachDropped, (path) => {
    const parsed = pathSchema.safeParse(path)
    if (!parsed.success) throw new Error('Unknown file.')
    return attachments.attachDropped(parsed.data)
  })
  // Takes no arguments on purpose: the files always come from the native picker.
  handle(attachmentsChannels.attachmentsPick, () => attachments.pick())
  handle(attachmentsChannels.attachmentsFromPaste, (bytes, mime, name) => {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > ATTACHMENT_PASTE_MAX_BYTES)
      throw new Error('That paste is too big to attach.')
    const parsedMime = mimeSchema.safeParse(mime)
    const parsedName = nameSchema.safeParse(name)
    if (!parsedMime.success || !parsedName.success) throw new Error('Invalid paste.')
    return parsedName.data === undefined
      ? attachments.fromPaste(bytes, parsedMime.data)
      : attachments.fromPaste(bytes, parsedMime.data, parsedName.data)
  })
  // Takes no arguments.
  handle(attachmentsChannels.attachmentsHeicSupport, () => attachments.heicSupport())
  handle(attachmentsChannels.attachmentsCopyIntoFolder, (id, folder) => {
    const parsedId = idSchema.safeParse(id)
    const parsedFolder = locationSchema.safeParse(folder)
    if (!parsedId.success || !parsedFolder.success) throw new Error('Unknown attachment.')
    return attachments.copyIntoFolder(parsedId.data, parsedFolder.data)
  })
}
