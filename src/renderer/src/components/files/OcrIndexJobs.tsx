import type { OcrIndexJob } from '../../../../shared/ipc-ocr-index'
import { isActiveJob, type OcrIndexControls } from './use-ocr-index'

/** What each state is called, short. */
export const OCR_STATE_LABEL: Record<OcrIndexJob['state'], string> = {
  queued: 'Queued',
  checking: 'Finding scanned pages',
  reading: 'Reading pages',
  waiting: 'Waiting for a search',
  paused: 'Paused',
  battery: 'Paused on battery',
  finished: 'Done',
  stopped: 'Stopped',
}

const count = (n: number): string => n.toLocaleString('en-US')
const plural = (n: number, word: string): string => `${count(n)} ${word}${n === 1 ? '' : 's'}`

/** The job's progress in words: pages once known, files while they are being checked. */
export function progressText(job: OcrIndexJob): string {
  if (job.state === 'checking' || (job.filesChecked < job.filesTotal && job.pagesTotal === 0)) {
    return `${count(job.filesChecked)} of ${plural(job.filesTotal, 'PDF')} checked`
  }
  if (job.pagesTotal === 0 && job.state === 'queued') return 'Not started yet'
  const left =
    job.minutesLeft !== null && isActiveJob(job)
      ? ` · about ${plural(job.minutesLeft, 'minute')} left`
      : ''
  return `${count(job.pagesDone)} of ${plural(job.pagesTotal, 'page')} read${left}`
}

/** The share done, 0 to 100: files while checking, pages after. */
function percent(job: OcrIndexJob): number {
  const [done, total] =
    job.state === 'checking' ? [job.filesChecked, job.filesTotal] : [job.pagesDone, job.pagesTotal]
  if (total <= 0) return job.state === 'finished' ? 100 : 0
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)))
}

/**
 * The Files panel's background indexing of scanned documents: one entry per folder, with its
 * progress and Pause/Resume, Cancel and (once done) Dismiss. Nothing here takes focus or
 * announces progress ticks: only a change of state is announced, politely, so an approval
 * dialog keeps the user's attention.
 */
export function OcrIndexJobs({
  controls,
}: {
  controls: OcrIndexControls
}): React.JSX.Element | null {
  const { jobs } = controls
  if (jobs.length === 0) return null
  return (
    <section className="ocr-index" aria-labelledby="ocr-index-title">
      <h3 id="ocr-index-title" className="sidebar-label">
        Scanned documents
      </h3>
      <ul className="ocr-index-list">
        {jobs.map((job) => (
          <OcrIndexEntry key={job.id} job={job} controls={controls} />
        ))}
      </ul>
    </section>
  )
}

function OcrIndexEntry({
  job,
  controls,
}: {
  job: OcrIndexJob
  controls: OcrIndexControls
}): React.JSX.Element {
  const active = isActiveJob(job)
  const paused = job.state === 'paused'
  const value = percent(job)
  const progress = progressText(job)
  const problem = job.state === 'stopped'
  return (
    <li className={`ocr-job ocr-job-${job.state}`}>
      <div className="ocr-job-head">
        <span className="ocr-job-name" title={job.path}>
          {job.name}
        </span>
        <span className="ocr-job-state" aria-live="polite">
          <span className="visually-hidden">{job.name}: </span>
          {OCR_STATE_LABEL[job.state]}
        </span>
      </div>
      <div
        className="ocr-job-bar"
        role="progressbar"
        aria-label={`Indexing ${job.name}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
        aria-valuetext={progress}
      >
        <span style={{ inlineSize: `${String(value)}%` }} />
      </div>
      <p className="ocr-job-progress">{progress}</p>
      {job.message && (
        <p className={problem ? 'ocr-job-message ocr-job-problem' : 'ocr-job-message'}>
          {job.message}
        </p>
      )}
      {(job.pagesFailed > 0 || job.cloudOnly > 0 || job.skipped > 0) && (
        <ul className="ocr-job-notes">
          {job.pagesFailed > 0 && <li>{plural(job.pagesFailed, 'page')} OCR could not read</li>}
          {job.cloudOnly > 0 && (
            <li>
              {plural(job.cloudOnly, 'online-only file')} not downloaded: open{' '}
              {job.cloudOnly === 1 ? 'it' : 'them'} in Explorer to download, then index again
            </li>
          )}
          {job.skipped > 0 && (
            <li>{plural(job.skipped, 'PDF')} skipped (too large, protected or unreadable)</li>
          )}
        </ul>
      )}
      <div className="ocr-job-actions">
        {active && !paused && (
          <button
            type="button"
            aria-label={`Pause indexing ${job.name}`}
            onClick={() => {
              void controls.pause(job.id)
            }}
          >
            Pause
          </button>
        )}
        {(paused || problem) && (
          <button
            type="button"
            aria-label={`${problem ? 'Try indexing' : 'Resume indexing'} ${job.name}${problem ? ' again' : ''}`}
            onClick={() => {
              void controls.resume(job.id)
            }}
          >
            {problem ? 'Try again' : 'Resume'}
          </button>
        )}
        {active ? (
          <button
            type="button"
            aria-label={`Cancel indexing ${job.name}`}
            onClick={() => {
              void controls.cancel(job.id)
            }}
          >
            Cancel
          </button>
        ) : (
          <button
            type="button"
            aria-label={`Dismiss indexing of ${job.name}`}
            onClick={() => {
              void controls.dismiss(job.id)
            }}
          >
            Dismiss
          </button>
        )}
      </div>
    </li>
  )
}
