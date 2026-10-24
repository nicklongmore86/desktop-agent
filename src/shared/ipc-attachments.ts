/**
 * Attachments: files the user drops, picks or pastes into the composer. Channel
 * names and result types shared by main, preload and renderer. One of the
 * per-feature IPC modules; see docs/ipc-modules.md.
 *
 * Main reads and checks every file and keeps the bytes. The renderer only gets
 * an AttachmentRef (an opaque id plus display metadata) or, for text files and
 * folders inside a granted folder, the `@"path"` reference text to insert. It never
 * sends a path back: the one path that crosses IPC is the dropped file's, which the
 * preload reads from the File itself (`webUtils.getPathForFile`).
 */
import type { AttachmentRef } from './attachments'
import type { FileLocation } from './ipc-files'

export const attachmentsChannels = {
  attachmentsAttachDropped: 'attachments:attach-dropped',
  attachmentsPick: 'attachments:pick',
  attachmentsFromPaste: 'attachments:from-paste',
  attachmentsCopyIntoFolder: 'attachments:copy-into-folder',
} as const

/** Biggest paste (clipboard image or file bytes) the bridge sends; main checks it again. */
export const ATTACHMENT_PASTE_MAX_BYTES = 10 * 1024 * 1024
/** Longest dropped path main accepts, in characters. */
export const ATTACHMENT_MAX_PATH = 4096
/** Longest MIME type a paste may name. */
export const ATTACHMENT_MAX_MIME = 100
/** Longest name a paste may give its file. */
export const ATTACHMENT_MAX_NAME = 255

/** Where an attachment came from (audit `args.source`). */
export type AttachVia = 'drop' | 'picker' | 'paste'

/**
 * Why an attachment was refused; also the audit `error` code. `grant-folder`: a folder
 * outside the granted folders (grant it in Settings → Folders instead).
 */
export type AttachErrorCode =
  | 'secret'
  | 'blocked'
  | 'too-large'
  | 'binary'
  | 'link'
  | 'not-found'
  | 'invalid'
  | 'grant-folder'
  | 'too-many'
  | 'failed'

export type AttachOutcome =
  /** A text file or folder inside a granted folder: insert `text` (`@"path"`) into the message. */
  | { ok: true; kind: 'reference'; text: string }
  /**
   * A one-time, read-only snapshot held by main. `outsideGrant`: the file is not in a granted
   * folder, so the agent cannot open it again; the UI may offer "Copy into folder…".
   */
  | { ok: true; kind: 'attachment'; attachment: AttachmentRef; outsideGrant: boolean }
  | { ok: false; code: AttachErrorCode; reason: string }

export type CopyIntoFolderResult =
  { ok: true; text: string } | { ok: false; declined?: boolean; reason: string }

export interface AttachmentsApi {
  attachments: {
    /** Shows the native file picker (several files); one outcome per chosen file, [] if cancelled. */
    pick: () => Promise<AttachOutcome[]>
    /** Clipboard bytes (a screenshot, a copied image). Refused over ATTACHMENT_PASTE_MAX_BYTES. */
    fromPaste: (bytes: Uint8Array, mime: string, name?: string) => Promise<AttachOutcome>
    /**
     * Copies a snapshot taken from outside the granted folders into a granted folder, after
     * the user approves it in the usual approval dialog. On success `text` is the new file's
     * `@"path"` reference.
     */
    copyIntoFolder: (id: string, folder: FileLocation) => Promise<CopyIntoFolderResult>
  }
}

/** What `files.attachDropped` adds to the files API (see preload/files.ts). */
export interface FilesAttachApi {
  /** A File from a drop or paste event. Only its path (read in the preload) reaches main. */
  attachDropped: (file: File) => Promise<AttachOutcome>
}
