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
- a preload that only hands over a `MessagePort`. Bytes (copies, never paths) and the
  PDFium WASM, read by the main process from the app's files, travel over that port;
  the worker's answers are validated (zod) before use;
- one job at a time, a 30 s wall-clock timeout and a working-set ceiling (polled with
  `app.getAppMetrics`) after which the window is destroyed; recycling after 25 jobs and
  after 60 s idle. A worker starts in about 100–150 ms.

The worker page is built by a nested Vite build in `electron.vite.config.ts` into
`out/document-worker/`; `out/main/documents.js` and `out/preload/document-worker.js` are
extra entries. Packaging needs nothing new: `files: out/**/*` covers them.

## Limits

`limits.ts`: 100 MB per document; 100 megapixels per decoded or rendered image, checked
from the header before decoding; 50 pages and 20 images per call; long edge up to
4096 px. `zip.ts` is the guarded ZIP reader for the later OOXML/ODF work: entry-count,
declared-size and ratio caps up front, then streaming inflation that counts real bytes
against the entry's declared size and an archive-wide budget.

## Tests

- Unit (Vitest, Node): `sniff`, `limits`, `zip`, `exif`, `extract` (real PDFium WASM
  with stand-in codecs, including the malformed corpus) and `worker-host` (mocked
  Electron: timeout, memory kill, recycling, result validation, request filter).
- Real Electron (Playwright, `e2e/document-worker.spec.ts`, after `pnpm build`): a PDF
  (text, rendered page, region), a rotated JPEG with EXIF, the sandbox probe, the
  malformed corpus, the timeout kill and recycling. Runs on Linux and Windows CI.
