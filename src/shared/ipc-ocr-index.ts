/**
 * Background indexing of scanned PDF pages (OCR), started by the user from the Files panel:
 * channel names and types shared by main, preload and renderer. One of the per-feature IPC
 * modules; see docs/ipc-modules.md and docs/ocr-index.md.
 *
 * The renderer names a folder as the Files tree does (a granted folder's opaque id and a
 * relative path) and a job by the id main gave it. It never sends a path. Every message in a
 * job is fixed text written in main: never a file name or anything read from a document.
 */
import type { FileLocation } from './ipc-files'

export const ocrIndexChannels = {
  ocrIndexList: 'ocr-index:list',
  ocrIndexStart: 'ocr-index:start',
  ocrIndexPause: 'ocr-index:pause',
  ocrIndexResume: 'ocr-index:resume',
  ocrIndexCancel: 'ocr-index:cancel',
  ocrIndexDismiss: 'ocr-index:dismiss',
} as const

/** Main -> renderer: the jobs changed (state or progress). Sent at most a few times a second. */
export const ocrIndexPushChannels = {
  ocrIndexChanged: 'ocr-index:changed',
} as const

/** A job's id: 16 lowercase hex digits. */
export const OCR_INDEX_JOB_ID = /^[0-9a-f]{16}$/

/**
 * - `queued`: waiting for another folder's indexing to finish.
 * - `checking`: finding the scanned pages (each PDF's text layer, read once and kept).
 * - `reading`: reading scanned pages with OCR.
 * - `waiting`: making way for a search, which comes first.
 * - `paused`: paused by the user.
 * - `battery`: paused while the PC runs on battery; goes on when it is plugged in.
 * - `finished`: every scanned page it could read was read.
 * - `stopped`: OCR cannot run, or failed again and again (`message` says which).
 */
export type OcrIndexState =
  'queued' | 'checking' | 'reading' | 'waiting' | 'paused' | 'battery' | 'finished' | 'stopped'

export interface OcrIndexJob {
  id: string
  /** The folder, as the Files tree names it. */
  rootId: string
  rel: string
  /** The folder's name and full path: for display only. */
  name: string
  path: string
  state: OcrIndexState
  /** PDFs whose pages have been checked, of those found. */
  filesChecked: number
  filesTotal: number
  /** Scanned pages read (or that OCR gave up on for good), of those found so far. */
  pagesDone: number
  pagesTotal: number
  /** Pages OCR could not read: for good, or this time (tried again on the next run). */
  pagesFailed: number
  /** Rough time left at the rate so far, or null while there is no rate yet. */
  minutesLeft: number | null
  /** OneDrive files that are online-only: never downloaded, so not read. */
  cloudOnly: number
  /** PDFs not read: too large, password-protected, damaged, hard-linked or secret-looking. */
  skipped: number
  /** Fixed text from main about the state, or null. */
  message: string | null
}

export type OcrIndexResult = { ok: true } | { ok: false; reason: string }

export interface OcrIndexApi {
  ocrIndex: {
    /** Every job, running, waiting or done (until dismissed). */
    list: () => Promise<OcrIndexJob[]>
    /** Starts indexing a granted folder or a folder inside one. */
    start: (location: FileLocation) => Promise<OcrIndexResult>
    pause: (id: string) => Promise<OcrIndexResult>
    resume: (id: string) => Promise<OcrIndexResult>
    /** Stops it for good. Pages already read stay read; nothing else is deleted. */
    cancel: (id: string) => Promise<OcrIndexResult>
    /** Removes a finished or stopped job from the list. */
    dismiss: (id: string) => Promise<OcrIndexResult>
    onChanged: (listener: (jobs: OcrIndexJob[]) => void) => () => void
  }
}
