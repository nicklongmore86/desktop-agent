# Document reader

`src/main/documents/` reads documents and images for the agent: the parser and its
sandbox (below), used by the `read_document` tool and by PDF and Office attachments.

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
- AVIF photos are decoded the same way (Chromium has an AV1 decoder; it applies the
  `clap` crop and `irot`/`imir` itself). HEIC photos are decoded by Windows' own codec: see
  [HEIC photos](#heic-photos). For both, `heif.ts` reads the container first (stored size,
  crop, rotation, the Exif item), so the 100 MP check and the EXIF text work as for JPEG.
  An EXIF orientation tag inside a HEIF file is ignored: `irot`/`imir` decide.
- Office and OpenDocument files: see [Office documents](#office-documents). RTF is
  detected and answered with a "not supported yet" warning.

## Office documents

All of it runs in the sandboxed worker, under the same 30 s timeout and memory ceiling.

- Packages (`package.ts`): every OOXML and ODF file is opened with the guarded ZIP reader
  (`zip.ts`: entry count, declared sizes and ratios up front, real inflated bytes counted
  against what each entry declares and an archive budget), with tighter caps on top
  (`limits.office`): 64 MB per part and 256 MB per package, uncompressed.
- XML (`xml.ts`): a small parser of our own, written for hostile input. A DOCTYPE is
  refused outright, so there are no entity definitions to expand (no billion laughs) and
  nothing external to load (no XXE); only the five predefined entities and character
  references are decoded. Nesting depth (256) and elements per part (4 million) are
  capped. Names are namespace-resolved to the usual prefixes (`w:`, `a:`, `p:`, `text:`),
  whatever prefix the file used, and each reader keeps only the elements it reads, so a
  large part costs little more memory than its text.
- Word (`docx.ts`): the body as Markdown-like text: headings (`#`, from the style's name
  or outline level, through `basedOn`), list items (`-` or `1.`, indented by level, from
  `numbering.xml` and paragraph or style numbering), tables as Markdown tables (merged and
  spanned cells padded; a table inside a cell flattened onto one line), text boxes after
  their paragraph, pictures as `[Image: alt text]` (counted in a note, not rendered).
  Deleted text, field codes and `mc:Fallback` copies are left out. Title and author come
  from `docProps/core.xml`.
- PowerPoint (`pptx.ts`): slides in `sldIdLst` order (not part-name order), each with its
  title placeholder as `# title`, the text of its shapes in order (indented by level),
  tables as Markdown, pictures as `[Image: alt text]`, then `Speaker notes:` from its
  notes slide's body placeholder (not the slide image, number, header or footer). Hidden
  slides say so in their title.
- Workbooks (`sheets.ts`): Excel (.xlsx, .xlsm, .xls) and OpenDocument spreadsheets are
  parsed by SheetJS, which never sees the ZIP: the package's parts are inflated by the
  guarded reader and handed to SheetJS's `parse_zip` as an in-memory container, so every
  archive limit applies. Parts that declare a DTD are refused first; only the XML parts a
  workbook needs are handed over (never `vbaProject.bin`, media or embedded objects), so
  macros are never run or read (a note says a workbook has them). Each sheet is a
  Markdown table whose header is the column letters and whose first column is the row
  number, so every cell has its address. Values are the cached ones (`w`, else `v`);
  `includeFormulas` adds `(=formula)` after the value, and a formula with no value shows
  its text. An .xls formula whose cached result is 0 shows as `0 (=A1*2; may be unsaved)`,
  with a note once per sheet: writers that do not calculate (such as xlwt) store 0 as a
  placeholder, which cannot be told from a computed 0. Nothing is recalculated. With no sheet or range, the view lists every sheet
  (name, used range, hidden) and shows its first 20 rows and 30 columns, until the text
  or cell budget is spent; a range (`Sheet1!A1:H200`, `'Q3 sales'!B2:F40`, `A:C`, `5:20`,
  `A21:H`) reads those cells, at most 10,000 per call and within the text budget, and
  each sheet section names the range to read next. SheetJS is told how many rows to
  parse (`sheetRows`), so a sheet is not parsed past what a call can show. CSV and
  tab-separated text (by a `.csv`/`.tsv` name or a CSV MIME type; the delimiter guessed
  from the first line) goes through a small RFC 4180 parser of ours into the same tables.
- OpenDocument (`odf.ts`): text documents read like Word (`text:h` outline levels,
  nested lists, tables with repeated rows and columns expanded within limits, `text:s`
  spaces), presentations like PowerPoint (`draw:page`, title frames, notes); `.ods` goes
  to SheetJS as above. A compressed `mimetype` entry is tolerated.
- Legacy OLE files (`ole.ts`), opened with SheetJS's CFB reader: Excel 97-2003 goes to
  SheetJS; Word 97-2003 gets a best-effort text extraction from the piece table (8-bit
  and UTF-16 pieces, field instructions dropped and results kept, no headings or table
  layout, with a note); Word 95 and older, PowerPoint 97-2003 (.ppt) and Excel binary
  workbooks (.xlsb) are refused with "save it as .docx/.pptx/.xlsx"; an OLE file holding
  an encrypted package (a password-protected .docx/.xlsx/.pptx) is `password-protected`.
- Positions: Word, OpenDocument text and .doc move by characters of the text produced
  (`unit: 'char'`), cut at a line break in the second half of the window, so a long
  document is continued with `start` whatever its pages or sections; slides move like
  pages (`unit: 'slide'`, `meta.pageCount` is the slide count); workbooks move by sheet
  (`unit: 'sheet'`, `meta.sheets` lists them) and within a sheet by range.

## HEIC photos

No HEVC decoder is bundled (licensing and patents). HEIC is decoded by the Windows
Imaging Component's HEIF decoder ("HEIF Image Extensions", Microsoft Store) and the HEVC
decoder it uses ("HEVC Video Extensions", Microsoft Store), through a small helper of our
own, `heif-decode.exe` (`native/heif-decode/heif-decode.c`), bundled and verified exactly
like [job-run.exe](job-run.md#integrity-and-fallback).

Why a helper: Chromium never uses the system's image codecs (it has no HEVC still-image
decoder on any platform: `createImageBitmap` on a HEIC blob fails in the worker), and
decoding through PowerShell/.NET would start a script host per photo (slow, and the kind
of process antivirus watches) with no way to lock it down. A helper is a few hundred
lines of C that imports only Windows' own DLLs.

```
main --bytes--> worker (sandboxed page)        reads ftyp/meta: ispe, clap, irot/imir, Exif;
                                               100 MP check; EXIF text; asks for a decode
main --the same original bytes--> heif-decode.exe (locked down, see below) --> PNG
main --that PNG--> worker                      decodes it with Chromium, turns it upright if
                                               the codec did not, scales, re-encodes
main <-- checked twice (broker, main) -- one PNG or JPEG, no metadata
```

- Main never parses the photo or the helper's PNG: it hands the original bytes to the
  helper (never anything the worker sent), counts the bytes coming back (at most 100 MB,
  and they must start with a PNG signature), and gives them to the worker, whose answer is
  checked by `reply.ts` like any image (real PNG/JPEG headers, dimensions, 5 MB).
- The helper, before reading a byte of the photo: joins a Job Object of its own (no other
  process may start in it, a memory ceiling equal to the worker's, 60 s of CPU, killed on an
  unhandled exception, no desktop, clipboard, global atoms or other processes' USER
  handles); lowers its token to Low integrity; turns on mitigations (no extension points, no
  remote or Low-labelled DLLs, System32 first, no non-system fonts, strict handle checks).
  If any step fails it decodes nothing and reports the step.
- Only WIC's HEIF decoder sees the bytes (`CreateDecoder(GUID_ContainerFormatHeif)`); the
  frame size the decoder reports is checked against 100 MP before any pixel is asked for
  (the worker already checked `ispe`); the image is scaled to the request's long edge by
  WIC and written as a 24-bit PNG with no metadata. Main kills it at the 30 s timeout.
- One report line, last on stderr (`heif-decode:1 ok width=… height=…`, `… error=<step>
code=0x…`, `… probe heif=0|1 hevc=0|1`), parsed strictly; anything else fails the job.
  Lines before it are the codec's own messages (WIC's JPEG decoder writes "Not a JPEG
  file: …" there) and are ignored; main keeps the last 4 KB of stderr.
- Orientation: reports disagree on whether WIC applies `irot`/`imir` itself (the more
  recent say it does). The worker decides from the PNG: if a quarter turn should have
  swapped portrait and landscape and did not, it turns the image itself
  (`remainingTurn`); a turn that keeps the shape (180°, a mirror) is taken as applied.
- Codec detection: `heif-decode.exe --probe`, under the same lockdown, checks for WIC's
  HEIF decoder and for an HEVC decoder MFT (`MFTEnumEx`). Done once per session
  (`SystemImageDecoder.support()`), never throws (any failure is "not available, because
  …"), logged once, and shown on HEIC chips. Without the codecs a HEIC photo is refused
  with `unsupported` and what to install: "This photo is HEIC. Install “HEIF Image
  Extensions” and “HEVC Video Extensions” from the Microsoft Store, or export it as JPEG,
  and try again." (or just the one that is missing). On Linux and macOS: "… can decode
  only on Windows …". With `view: 'text'` (attachments for a model without vision) the
  metadata is still read, and nothing is decoded.
- `heif-decode.exe --decode --format jpeg` uses WIC's JPEG decoder instead: the Windows CI
  runner has no Store codecs, so that is how the whole decode path is tested there.

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

`reply.ts` holds a reply to the request and the limits: at most 20 images and 50 pages
(or slides, or sheets); at most 51 sections; for workbooks at most 200 listed sheets,
names up to 200 characters, every range an A1 reference, a sheet list matching the
position, and sheets only on a workbook; text within the request's budget (hard cap 500,000 characters)
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

- Input: `path`; one of `pages` (`"3"`, `"2-5"`, `"10-"`, pages or slides), `start` (the
  page, slide, character or sheet a previous call named), `region` (`{page, x, y, width,
height}` as fractions of a PDF page, zoomed up to 8x), or `sheet`/`range` for a
  workbook (`range` may name the sheet: `"Sheet1!A1:H200"`); `include_formulas`;
  `include_location`.
- The path goes through the same guard as `read_file` (granted folders, realpath, the
  secret and protected-path blocklist) and is opened with `openVerified` (no links, one
  hard link, the handle re-checked); the worker gets a copy of the bytes, never the path.
- `content` is text: a header (path, type, size, pages/slides/characters/sheets, range
  shown, title, author), the text page by page (pages also attached as images say so),
  slide by slide (`--- Slide 3: title ---`) or sheet by sheet (a `Sheets:` list, then
  `--- Sheet "Sales": A1:D20 of A1:D60 ---` and a table, and `[More of "Sales": call
read_document with range: "Sales!A21:D60" to continue.]`), notes, and the last line
  says where to continue (`start: N`) or that the document ended. `images` (`ToolImage`) holds
  rendered pages (`label: "page 3"`), a zoomed region, or the photo (upright, scaled,
  re-encoded without EXIF/GPS); `content` makes sense without them.
- Photos: capture time and camera come back as text; the location only with
  `include_location`. The audit entry records `includeLocation` when it was asked for and
  `locationRead: true` when a location was actually returned, plus the kind and image
  count (`RunResult.audit`, merged into the entry's args by `defineTool`).
- HEIC (where Windows' codecs are installed) and AVIF read like any photo; HEIC without
  the codecs, or off Windows, is an `unsupported` error saying what to install. RTF is
  answered with a "not supported yet" error (`unsupported`), .ppt,
  .xlsb and Word 95 with "save it as ..."; text files are pointed to `read_file` (CSV and
  TSV are read as tables), and `read_file`'s binary refusal points PDFs, images and
  Office files to `read_document`. The audit entry records `sheet`, `range` and
  `includeFormulas` when they were given.
- Reader refusals and worker failures (timeout, crash, memory, a misbehaving worker)
  become ordinary error results with an audit category (`unreadable`, `out-of-range`,
  `timeout`, `worker-failed`, ...); the agent never sees an exception.

The app owns one `DocumentWorkerHost` (`src/main/index.ts`), shared by the tool and
attachments and disposed on `will-quit`.

## PDF and Office attachments

When a chat is sent, `toModelConversation` (`src/main/chat/attachments.ts`) reads each
PDF attachment with the same host: its text page by page in a fenced block marked as
user-provided, untrusted data, and pages with little or no text (drawings, scans) as
image blocks for every connection whose model can see images (`AgentRunner.vision`, see
`docs/provider-images.md`: each client sends them in its own form, within the request's
image budget), a note in their place for the rest. Pages are rendered only while the
request's image budget (20) is not spent, newest attachment first as the runner budgets
them, 8 per PDF at most; older PDFs are sent as text. A connection known not to see
images has its PDFs read as text only, with no page rendered. Results are cached per
attachment id (at most 16 PDFs and 64 MB, least recently used out first; a view larger
than that is used once and not kept), so sending a chat again does not parse its PDFs
again. A text-only view is read again, with its pages, when a send can use them. A PDF
that cannot be read is sent as a placeholder saying why. PDF chips are no longer greyed in the composer.

Word, Excel, PowerPoint and OpenDocument attachments, and Word and Excel 97-2003 ones
(`READABLE_DOCUMENT_MIMES`, by the MIME type the classifier recorded), are read the same
way, as text only (`view: 'text'`), through the same cache (`cachedPdfReading`, keyed by
attachment id, byte-bounded): a document's text, a presentation's slides and notes, or a
workbook's sheet list and first rows, in one fenced block marked as user-provided,
untrusted data, with a note when only part was sent (`documentBlocks`). One that cannot
be read is a placeholder saying why. Their chips are no longer greyed (`canReceive`
takes the MIME type); older PowerPoint, RTF and mail still are.

## Limits

`limits.ts`: 100 MB per document; 100 megapixels per decoded or rendered image, checked
from the header before decoding; 50 pages and 20 images per call; long edge up to
4096 px. `zip.ts` is the guarded ZIP reader for OOXML and ODF: entry-count,
declared-size and ratio caps up front, then streaming inflation that counts real bytes
against the entry's declared size and an archive-wide budget. `limits.office`: 64 MB per
XML part and 256 MB per package uncompressed, XML depth 256 and 4 million elements per
part, 10,000 cells per call, a 20 x 30 preview per sheet, 200 sheets listed.

## Tests

- `read_document` (`src/main/tools/read-document.test.ts`, fake reader): output, ranges
  and regions, photos and the GPS gate with its audit fields, unsupported types, clean
  errors, and the guard (outside the grant, secret and protected files, symlink, hard
  link, size). `src/main/tools/read-document-providers.test.ts` runs the tool in the agent
  loop against fake Claude API and OpenAI-compatible servers: its page images arrive in
  the Claude `tool_result` and in the user message after the OpenAI `tool` message, and
  never without vision. In real Electron, `e2e/read-document.spec.ts` runs the tool
  (`out/main/tools.js`, built from `src/main/tools/e2e-entry.ts`) over the real worker.
- Unit (Vitest, Node): `sniff`, `limits`, `zip`, `exif`, `xml` (DTD refusal, depth and
  element caps, namespaces, broken XML), `office` (every format from real files built in
  memory by `office-fixtures.test-util.ts`: workbooks written by SheetJS, Word,
  PowerPoint and ODF from their XML parts, .doc/.ppt as OLE files; ranges, cell caps and
  continuation; hostile files: zip bombs by ratio and by a lying entry, XXE, billion
  laughs, a DTD in a part for SheetJS, oversized shared strings, tables nested past the
  depth cap, too many elements; every view also passed through `checkReply`), `extract`
  (real PDFium WASM with stand-in codecs, including the malformed corpus), `reply` (every limit, the Office shapes included) and
  `worker-host` (mocked Electron and broker: no port held by main, timeout, broker
  crash and violation, memory kill, recycling, request filter).
- Real Electron (Playwright, `e2e/document-worker.spec.ts`, after `pnpm build`): a PDF
  (text, rendered page, region), a rotated JPEG with EXIF, the 5 MB image cap, the
  sandbox probe, every Office and OpenDocument format and the hostile Office corpus inside
  the worker, the malformed corpus, the timeout kill and recycling.
  `e2e/read-document.spec.ts` also reads Word, Excel (listing, then a range) and
  PowerPoint (slide by slide) through the tool. A hostile
  worker (`e2e/harness/hostile-worker.js`, swapped into a copy of the built worker)
  posts transferred ArrayBuffers, oversized and over-count replies, floods and junk:
  each job fails, main's event loop keeps turning, the broker and window are gone,
  and the next job works. Runs on Linux and Windows CI.
- HEIC and AVIF: `heif.test.ts` (the container reader on real photos from
  `heif-fixtures.test-util.ts`, irot/imir, truncation and random corruption), `extract`
  (the decode request, the 100 MP refusal before any decode, AVIF in the worker,
  `remainingTurn`), `reply` (a decode request only for HEIC, within limits), `worker-host`
  (the original bytes to the decoder, the PNG back through the worker, a missing codec, a
  caller cannot pass `systemDecoded`), `system-heif.test.ts` (non-Windows, each missing
  package, the probe cached and never throwing, the decoder re-verified before each
  decode, every reported failure, bad output, and the spawner against a real child
  process). On Windows CI, `heif-decode.test.ts` runs the real exe: pin, probe (logged),
  the codec-missing path, and the whole decode path with WIC's JPEG decoder (scaling, the
  pixel cap, input cap, bad arguments); the installer job checks the packaged one. In
  real Electron, `e2e/document-worker.spec.ts` decodes AVIF upright, refuses HEIC with the
  platform's reason (or decodes it where the codecs are installed), refuses over-100 MP
  headers, and turns a stand-in codec's stored-orientation PNG upright exactly once.
- Manual (Windows with the codecs, which CI cannot have): attach an iPhone portrait photo
  (`.HEIC`) to a chat with a vision model, and call `read_document` on one: it comes back
  upright, with capture time and camera as text, and `include_location` adds GPS.
