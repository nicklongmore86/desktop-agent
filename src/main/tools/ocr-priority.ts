// Searches come before background indexing of scanned pages. Both use the one document reader
// (which holds one background job at a time) and the OCR helpers. A search that reads documents
// holds a claim; while any claim is held, indexing starts no new reader job and no new page, and
// the pages it is reading finish and are kept. Before a search reads scanned pages itself, it
// waits for that (quiet), so no page is read by both. See docs/ocr-index.md.
import { pause } from './search-documents'

export interface SearchClaim {
  /** Lets indexing go on once no other search holds a claim. Safe to call more than once. */
  release(): void
  /**
   * Resolves once indexing has stopped reading pages (its pages being read finished and kept),
   * or after `ms`, or when `signal` aborts: whichever comes first.
   */
  quiet(ms: number, signal: AbortSignal): Promise<void>
}

export class OcrPriority {
  private claims = 0
  private readonly freed = new Set<() => void>()
  /** Indexing's OCR of a document, until it has stopped. */
  private working = new Set<Promise<void>>()

  /** Whether a search holds a claim: indexing must make way. */
  get searching(): boolean {
    return this.claims > 0
  }

  claim(): SearchClaim {
    this.claims++
    let released = false
    return {
      release: () => {
        if (released) return
        released = true
        this.claims--
        if (this.claims === 0) {
          for (const wake of [...this.freed]) wake()
        }
      },
      quiet: async (ms, signal) => {
        if (this.working.size === 0 || ms <= 0 || signal.aborted) return
        await Promise.race([Promise.all(this.working), pause(ms, signal)])
      },
    }
  }

  /** Resolves once no search holds a claim, or when `signal` aborts. */
  whenFree(signal: AbortSignal): Promise<void> {
    if (this.claims === 0 || signal.aborted) return Promise.resolve()
    return new Promise((resolve) => {
      const done = (): void => {
        this.freed.delete(done)
        signal.removeEventListener('abort', done)
        resolve()
      }
      this.freed.add(done)
      signal.addEventListener('abort', done, { once: true })
    })
  }

  /** Indexing work a search's quiet() waits for: OCR of one document, until it has stopped. */
  track<T>(work: Promise<T>): Promise<T> {
    const settled: Promise<void> = work.then(
      () => undefined,
      () => undefined,
    )
    this.working.add(settled)
    void settled.then(() => this.working.delete(settled))
    return work
  }
}

/** How background indexing of a folder's scanned pages is going, for a search to mention. */
export interface OcrIndexNote {
  /** The folder being indexed (inside the grants). */
  folder: string
  /**
   * 'checking': finding the scanned pages; 'reading': reading them; 'waiting': making way for
   * a search; 'paused': by the user; 'battery': until the PC is plugged in; 'queued': after
   * another folder's indexing.
   */
  state: 'queued' | 'checking' | 'reading' | 'waiting' | 'paused' | 'battery'
  filesChecked: number
  filesTotal: number
  pagesDone: number
  pagesTotal: number
  minutesLeft: number | null
}

export interface OcrIndexStatus {
  /** Indexing still to finish for a folder inside `dir`, or holding it; null when there is none. */
  statusFor(dir: string): OcrIndexNote | null
}
