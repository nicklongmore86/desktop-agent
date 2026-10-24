# Document reader

`src/main/documents/` reads documents and images for the agent: the parser and its
sandbox (below), used by the `read_document` tool and by PDF attachments. Sending images
to every provider comes later; Office documents come next.

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

## The `read_document` tool

`src/main/tools/read-document.ts`, registered for every connection with the other file
tools. Read-only like `read_file`: no approval, but every call is audited.

- Input: `path`; one of `pages` (`"3"`, `"2-5"`, `"10-"`), `start` (the page a previous
  call named) or `region` (`{page, x, y, width, height}` as fractions of the page, zoomed
  up to 8x); `include_location`.
- The path goes through the same guard as `read_file` (granted folders, realpath, the
  secret and protected-path blocklist) and is opened with `openVerified` (no links, one
  hard link, the handle re-checked); the worker gets a copy of the bytes, never the path.
- `content` is text: a header (path, type, size, pages, range shown, title, author), the
  text page by page (pages also attached as images say so), notes, and the last line says
  where to continue (`start: N`) or that the document ended. `images` (`ToolImage`) holds
  rendered pages (`label: "page 3"`), a zoomed region, or the photo (upright, scaled,
  re-encoded without EXIF/GPS); `content` makes sense without them.
- Photos: capture time and camera come back as text; the location only with
  `include_location`. The audit entry records `includeLocation` when it was asked for and
  `locationRead: true` when a location was actually returned, plus the kind and image
  count (`RunResult.audit`, merged into the entry's args by `defineTool`).
- HEIC, AVIF, Office and other recognised formats are answered with a "not supported yet"
  error (`unsupported`); text files are pointed to `read_file`, and `read_file`'s binary
  refusal points PDFs and images to `read_document`.
- Reader refusals and worker failures (timeout, crash, memory, a misbehaving worker)
  become ordinary error results with an audit category (`unreadable`, `out-of-range`,
  `timeout`, `worker-failed`, ...); the agent never sees an exception.

The app owns one `DocumentWorkerHost` (`src/main/index.ts`), shared by the tool and PDF
attachments and disposed on `will-quit`.

## PDF attachments

When a chat is sent, `toModelConversation` (`src/main/chat/attachments.ts`) reads each
PDF attachment with the same host: its text page by page in a fenced block marked as
user-provided, untrusted data, and pages with little or no text (drawings, scans) as
image blocks for every connection whose model can see images (`AgentRunner.vision`, see
`docs/provider-images.md`: each client sends them in its own form, within the request's
image budget), a note in their place for the rest. Results are cached per attachment id (16 PDFs), so sending a
chat again does not parse its PDFs again; a PDF that cannot be read is sent as a
placeholder saying why. PDF chips are no longer greyed in the composer.

## Limits

`limits.ts`: 100 MB per document; 100 megapixels per decoded or rendered image, checked
from the header before decoding; 50 pages and 20 images per call; long edge up to
4096 px. `zip.ts` is the guarded ZIP reader for the later OOXML/ODF work: entry-count,
declared-size and ratio caps up front, then streaming inflation that counts real bytes
against the entry's declared size and an archive-wide budget.

## Tests

- `read_document` (`src/main/tools/read-document.test.ts`, fake reader): output, ranges
  and regions, photos and the GPS gate with its audit fields, unsupported types, clean
  errors, and the guard (outside the grant, secret and protected files, symlink, hard
  link, size). `src/main/tools/read-document-providers.test.ts` runs the tool in the agent
  loop against fake Claude API and OpenAI-compatible servers: its page images arrive in
  the Claude `tool_result` and in the user message after the OpenAI `tool` message, and
  never without vision. In real Electron, `e2e/read-document.spec.ts` runs the tool
  (`out/main/tools.js`, built from `src/main/tools/e2e-entry.ts`) over the real worker.
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
