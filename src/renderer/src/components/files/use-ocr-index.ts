import { useCallback, useEffect, useState } from 'react'
import type { FileLocation } from '../../../../shared/ipc-files'
import type { OcrIndexJob, OcrIndexResult } from '../../../../shared/ipc-ocr-index'
import { useApi } from '../../api'
import { useToast } from '../Toast'

/** States in which a job is still going (or will go on). */
const ACTIVE = new Set<OcrIndexJob['state']>([
  'queued',
  'checking',
  'reading',
  'waiting',
  'paused',
  'battery',
])

export const isActiveJob = (job: OcrIndexJob): boolean => ACTIVE.has(job.state)

/**
 * The background indexing jobs main runs, kept current by its pushes, and their controls.
 * A refused control shows main's reason as a toast.
 */
export function useOcrIndex() {
  const api = useApi()
  const notify = useToast()
  const [jobs, setJobs] = useState<OcrIndexJob[]>([])

  useEffect(() => {
    let live = true
    const off = api.ocrIndex.onChanged((next) => {
      if (live) setJobs(next)
    })
    void api.ocrIndex
      .list()
      .then((next) => {
        if (live) setJobs(next)
      })
      .catch(() => undefined)
    return () => {
      live = false
      off()
    }
  }, [api])

  const run = useCallback(
    async (action: () => Promise<OcrIndexResult>, done?: string): Promise<void> => {
      try {
        const result = await action()
        if (!result.ok) notify(result.reason)
        else if (done) notify(done)
      } catch {
        notify('That did not work.')
      }
    },
    [notify],
  )

  /** The job covering a folder (the same one, or one around it), if any is still going. */
  const coveringJob = useCallback(
    (location: FileLocation): OcrIndexJob | null =>
      jobs.find(
        (job) =>
          isActiveJob(job) &&
          job.rootId === location.rootId &&
          (job.rel === '' ||
            location.rel === job.rel ||
            location.rel.startsWith(`${job.rel}/`) ||
            job.rel.startsWith(location.rel === '' ? '' : `${location.rel}/`)),
      ) ?? null,
    [jobs],
  )

  return {
    jobs,
    coveringJob,
    start: (location: FileLocation) =>
      run(() => api.ocrIndex.start(location), 'Indexing scanned documents in the background'),
    pause: (id: string) => run(() => api.ocrIndex.pause(id)),
    resume: (id: string) => run(() => api.ocrIndex.resume(id)),
    cancel: (id: string) => run(() => api.ocrIndex.cancel(id), 'Indexing cancelled'),
    dismiss: (id: string) => run(() => api.ocrIndex.dismiss(id)),
  }
}

export type OcrIndexControls = ReturnType<typeof useOcrIndex>
