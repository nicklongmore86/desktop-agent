# Document reader

`src/main/documents/` reads documents and images for the agent. This first part is the
parser and its sandbox; the `read_document` tool, attachments and sending images to
providers come later.

## Shape

- `sniff.ts` decides what a file is from its leading bytes only (PDF, OOXML
  docx/xlsx/pptx, ODF, OLE/CFB, JPEG, PNG, GIF, WebP, BMP, TIFF, HEIC/HEIF, AVIF, RTF,
  text). The name and any claimed MIME type are ignored; a mismatch becomes a warning.
- `extract.ts` turns bytes into a `DocumentView` (`types.ts`): metadata, text sections,
  images (bytes, MIME, size, source page/region), a position (`unit`, `total`, `shown`,
  `next`) to page through long documents, and warnings.
- `pdf.ts` reads PDFs with PDFium (WASM): text per page within a character budget, page
  ranges, rendering of pages with little or no text (or every page with
  `view: 'images'`), and `select.region` to re-render part of a page larger, for
  drawings. A password-protected PDF is refused with `password-protected`.
- Images are decoded by Chromium (`createImageBitmap`, EXIF orientation applied),
  scaled to the caller's long edge (default 1568 px) and re-encoded on an
  `OffscreenCanvas`, so no EXIF or GPS data survives into the output. EXIF facts
  (capture time, camera, orientation) come back as text; GPS only with
  `includeLocation: true`. `exif.ts` is a small bounds-checked reader rather than a
  library: four tags need no 1.3 MB dependency in the attack surface.
- HEIC, AVIF and the Office formats are detected and answered with a "not supported
  yet" warning.

## Sandbox

`worker-host.ts` runs `extract` in a hidden `BrowserWindow`:

- the app's `secureWebPreferences` (sandbox, context isolation, no Node), a dedicated
  in-memory session (`document-worker`) that denies permissions and downloads, and
  `webRequest.onBeforeRequest` cancelling every request that is not a file inside
  `out/document-worker/`;
- CSP `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'`; navigation, new
  windows and webviews are refused;
- a preload that only hands over a `MessagePort`, whose other end is in the broker,
  not in main (see below). Bytes (copies, never paths) and the PDFium WASM, read by
  main from the app's files, go main -> broker -> worker;
- one job at a time, a 30 s wall-clock timeout and a working-set ceiling for the
  worker and broker together (polled with `app.getAppMetrics`), after which both are
  killed; recycling after 25 jobs and after 60 s idle. A worker starts in about
  100–200 ms.

### The broker

Main never holds a port the worker renderer can post to. Deserialising a message from
a renderer is itself an attack surface: a page that posts a value with a transferred
ArrayBuffer to a `MessagePortMain` hangs the process that reads it, and a page can
post as much data as it can allocate. So each worker has a broker, a utility process
(`broker.ts`, `out/main/document-broker.js`) holding the other end of its port:

```
main  <-- parentPort -->  broker (utility process)  <-- MessagePort -->  worker page
```

The broker is the only process that deserialises what the page sends. It checks each
reply with `reply.ts` and forwards only a fresh, bounded copy; on anything unexpected
it reports a violation and exits. A hostile page can hang or crash the broker, never
main: main keeps running, fails the job (at once on a crash or violation, at the
timeout on a hang) and kills the broker and the window. Main checks the broker's copy
with `reply.ts` again before using it.

`reply.ts` holds a reply to the request and the limits: at most 20 images and 50 pages;
at most 51 sections; text within the request's budget (hard cap 500,000 characters)
per section and in total, plus room for an image's EXIF section; images PNG or JPEG
with the magic bytes and header dimensions they claim, a long edge no larger than the
request's, at most 100 megapixels and 5 MB each; pages and positions inside the range
shown; strict shapes, the right job id and only known error codes. The worker enforces
the same limits itself (the encoders shrink an image until it fits in 5 MB); the
check is for a worker that does not.

Electron's ordinary renderer IPC (`ipcRenderer`) is out of the page's reach (context
isolation; the preload exposes nothing). A renderer compromised below the JavaScript
level can still send IPC to main, as any Electron renderer can; that boundary is
Electron's.

The worker page is built by a nested Vite build in `electron.vite.config.ts` into
`out/document-worker/`; `out/main/documents.js`, `out/main/document-broker.js` and
`out/preload/document-worker.js` are extra entries. Packaging needs nothing new: `files: out/**/*` covers them.

## Limits

`limits.ts`: 100 MB per document; 100 megapixels per decoded or rendered image, checked
from the header before decoding; 50 pages and 20 images per call; long edge up to
4096 px. `zip.ts` is the guarded ZIP reader for the later OOXML/ODF work: entry-count,
declared-size and ratio caps up front, then streaming inflation that counts real bytes
against the entry's declared size and an archive-wide budget.

## Tests

- Unit (Vitest, Node): `sniff`, `limits`, `zip`, `exif`, `extract` (real PDFium WASM
  with stand-in codecs, including the malformed corpus), `reply` (every limit) and
  `worker-host` (mocked Electron and broker: no port held by main, timeout, broker
  crash and violation, memory kill, recycling, request filter).
- Real Electron (Playwright, `e2e/document-worker.spec.ts`, after `pnpm build`): a PDF
  (text, rendered page, region), a rotated JPEG with EXIF, the 5 MB image cap, the
  sandbox probe, the malformed corpus, the timeout kill and recycling. A hostile
  worker (`e2e/harness/hostile-worker.js`, swapped into a copy of the built worker)
  posts transferred ArrayBuffers, oversized and over-count replies, floods and junk:
  each job fails, main's event loop keeps turning, the broker and window are gone,
  and the next job works. Runs on Linux and Windows CI.
