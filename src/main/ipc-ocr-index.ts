import { z } from 'zod'
import {
  OCR_INDEX_JOB_ID,
  ocrIndexChannels,
  type OcrIndexJob,
  type OcrIndexResult,
} from '../shared/ipc-ocr-index'
import { FILES_MAX_REL, type FileLocation } from '../shared/ipc-files'
import { ROOT_ID } from './files/location'
import type { IpcHandle } from './ipc-features'

/** Background indexing of scanned pages, as main provides it (ocr-index/service.ts). */
export interface OcrIndexIpcService {
  list: () => OcrIndexJob[]
  start: (location: FileLocation) => Promise<OcrIndexResult>
  pause: (id: string) => Promise<OcrIndexResult>
  resume: (id: string) => Promise<OcrIndexResult>
  cancel: (id: string) => Promise<OcrIndexResult>
  dismiss: (id: string) => Promise<OcrIndexResult>
}

// A folder is named as the Files tree names it: never an absolute path.
const locationSchema = z.strictObject({
  rootId: z.string().regex(ROOT_ID),
  rel: z.string().max(FILES_MAX_REL),
})
const idSchema = z.string().regex(OCR_INDEX_JOB_ID)

function jobId(value: unknown): string {
  const parsed = idSchema.safeParse(value)
  if (!parsed.success) throw new Error('Unknown indexing job.')
  return parsed.data
}

export function registerOcrIndexHandlers(handle: IpcHandle, service: OcrIndexIpcService): void {
  handle(ocrIndexChannels.ocrIndexList, () => service.list())
  handle(ocrIndexChannels.ocrIndexStart, (value) => {
    const parsed = locationSchema.safeParse(value)
    if (!parsed.success) throw new Error('Unknown folder.')
    return service.start(parsed.data)
  })
  handle(ocrIndexChannels.ocrIndexPause, (value) => service.pause(jobId(value)))
  handle(ocrIndexChannels.ocrIndexResume, (value) => service.resume(jobId(value)))
  handle(ocrIndexChannels.ocrIndexCancel, (value) => service.cancel(jobId(value)))
  handle(ocrIndexChannels.ocrIndexDismiss, (value) => service.dismiss(jobId(value)))
}
