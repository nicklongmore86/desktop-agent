# Background indexing of scanned documents

A folder of scanned PDFs (an RFI folder: about 1,700 documents, 2,200 to 3,100 scanned pages) takes longer to read with OCR than a search has. A `search_files` call has 3 minutes and a message about 20, and OCR reads 2 to 4 pages a second. So the user can have a folder's scanned pages read in the background: in the Files panel, right-click a granted folder (or a folder inside one) and choose **Index scanned documents**. Searches then find those pages without reading them again.

Indexing is only ever started by the user. Granting a folder starts nothing, and the agent cannot start it: when a search leaves many scanned pages unread and nothing is indexing them, the result suggests that the user start it (see [What a search says](#what-a-search-says)).

Main process: `src/main/ocr-index/service.ts`. Priority between searches and indexing: `src/main/tools/ocr-priority.ts`. IPC: `src/shared/ipc-ocr-index.ts`, `src/main/ipc-ocr-index.ts`, `src/preload/ocr-index.ts`. Renderer: `src/renderer/src/components/files/OcrIndexJobs.tsx` and `use-ocr-index.ts`.

## What a job does

1. **Checks the folder.** It walks the folder as a search does (the guard on every folder, links never followed, `.git` and `node_modules` skipped, up to 50,000 entries and 20 levels deep) and takes the files named `.pdf`. A file is left out, and counted, when its name looks like it holds secrets, it has other hard links or it is over the reader's 100 MB. A OneDrive file that is online-only is never read, which would download it: it is counted, and the panel says to open it in Explorer to download it and then index again.
2. **Finds the scanned pages.** For each PDF, the text the cache already holds, or else its text read through the reader and kept in the cache (exactly as `search_files` reads and keeps it). The pages that need OCR are those a search would read (`ocrReason`).
3. **Reads them.** Each PDF with pages left goes through `ocrDocument`, the same pipeline a search uses (#86): the sandboxed reader renders one page per background job, the pinned `ocr-text.exe` reads it at below-normal priority (two helpers at most, verified before every run), pages are kept in page order and saved every few seconds, and three failures in a row stop it. The bytes are read again through a checked handle; if the file changed since it was checked, its text is read again first.

One job runs at a time; the others wait as `queued`. A folder inside, or around, one already being indexed is refused.

## Searches come first

Both use the one document reader, which holds one background job at a time, and the OCR helpers.

- A search that reads documents takes a claim (`OcrPriority.claim()`) for as long as it does. While any claim is held, indexing starts no new reader job and no new page: its job shows `waiting`. The pages it is reading finish and are kept (`ocrDocument`'s `pauseWhen`), so no OCR work is thrown away.
- Before a search reads scanned pages itself, it waits for that (`claim.quiet()`, bounded by its own time left), then reads the document's text from the cache again. So a page is never read by both.
- A long PDF's text being read for indexing is given up on as soon as a search claims, and read again later.
- `read_document` and attachments already go ahead of every background job in the reader's queue, so they still wait behind at most one page's job.

## Pause, battery, cancel, restart, grants

- **Pause** stops starting pages; the ones being read finish and are kept. **Resume** goes on from the cache. A paused job lets the next queued folder run.
- **On battery** no new page starts (the OCR's `onBattery`, Electron's `powerMonitor.isOnBatteryPower()`), the job shows `battery`, and it goes on by itself once the PC is plugged in (it looks every second).
- **Cancel** stops the helpers at once (`TerminateProcess`). What was read and kept stays in the cache, where searches use it; nothing else is deleted.
- **Restart.** The cache is the progress. `userData/ocr-index.json` keeps only which folders are being indexed (the granted folder and a relative path) and whether each is paused. On the next start the jobs whose folders are still granted are taken up (the paused ones stay paused): each checks its folder again, which is quick for PDFs already in the cache, and goes on with the pages left. Pages being read at quit are read again.
- **Removing a grant** ends its jobs (`GrantStore.onRemove`). The cache deletes everything kept for that folder, and anything read after the grant went is not kept (`stillGranted` and the cache's grant token).
- **Stopped.** When OCR cannot run (not Windows, no OCR language, the helper missing or tampered with) a job does not start, or stops, with the reason. After three failures in a row it stops with **Try again**, which checks the folder again.

## What the panel shows

A **Scanned documents** section above the tree, one entry per folder: its name (full path on hover), its state, a progress bar (PDFs checked while checking, then pages read of pages found), _about N minutes left_ at this session's reading rate, a fixed message from main for the state, and counts of pages OCR could not read, online-only files and skipped PDFs. Buttons: Pause or Resume, Cancel, and Dismiss once finished or stopped.

Nothing in it takes focus, and only a change of state is announced (`aria-live="polite"`), never each page, so an approval dialog keeps the user's attention. There are no notifications. Every message comes from main as fixed text, never a file name or anything read from a document.

## What a search says

- When a job is indexing the searched folder (or a folder inside it): which state it is in, how far it got and the estimate, that only the pages read so far were searched, and that the agent should answer from those, tell the user indexing is under way, and offer to search again once it has finished. The search still reads pages itself, likeliest first, as before; its wording about what it covered (#84) is unchanged.
- When nothing is indexing it and 50 or more scanned pages were left unread for want of time or mains power: how many, and that the user can start **Index scanned documents** from the Files panel. The agent is told it cannot start it itself. There is no tool for it.

## Audit log

One `ocr_index` entry when a job starts (or resumes, also after a restart), stops (paused, cancelled, grant removed, OCR unavailable or failing) and completes. Its `args` hold counts only (PDFs checked and found, pages read and found, pages read this run, failed, online-only, skipped) and `paths` the folder. Never a file name or text.

## Tests

- `src/main/ocr-index/service.test.ts`: a scripted reader and a fake OCR. Every page read exactly once and kept, priority against a search (nothing new starts, the pages being read are kept, `quiet` waits for them), pause/resume/cancel, battery before and during, restart (running and paused), saved jobs for folders no longer granted, grant removal, online-only files never opened, failing pages, OCR unavailable, overlapping folders, one job at a time, and what `search_files` says (and that it reads no page indexing read or is reading).
- `src/main/ocr-index/service-real.test.ts` (Windows): the real helper and the real PDF code on a small folder; a search then finds the text with no more helper runs.
- `src/renderer/src/OcrIndex.test.tsx`: the menu item, the panel, the controls, refusals and what is announced.
- `e2e/ocr-index.spec.ts`: the same in real Electron, pointer and keyboard, with an approval dialog keeping the focus while progress comes in; screenshots `ocr-index-*` in `e2e-artifacts/ui/`.
- `src/main/ipc-handlers.test.ts`: the channels take only a Files-tree location or a job id.
