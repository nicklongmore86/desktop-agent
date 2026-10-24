# Attachments (main process)

Files the user drops, picks or pastes into the composer. Main checks and reads every
file; the renderer only ever holds an `AttachmentRef` (`src/shared/attachments.ts`) or
an `@"path"` reference to insert.

## Calls

| Call                                        | What it does                                                                                                                         |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `files.attachDropped(file)`                 | The preload reads the File's path with `webUtils.getPathForFile`; only that string crosses IPC. No path (zip-folder drags): refused. |
| `attachments.pick()`                        | Native multi-select picker in main. One outcome per file; `[]` if cancelled; more than `maxPerMessage` files: one `too-many`.        |
| `attachments.fromPaste(bytes, mime, name?)` | Clipboard bytes, capped at `ATTACHMENT_PASTE_MAX_BYTES` in the bridge and again in main. The kind comes from the bytes, not `mime`.  |
| `attachments.copyIntoFolder(id, folder)`    | For a snapshot taken from outside the grants: copies the original into a granted folder after the usual approval dialog.             |

## What a file becomes

- Inside a grant: text files and folders → `{ kind: 'reference', text: '@"path"' }` (via
  `referenceFor`, no size limit: the agent reads it with its tools). Images, PDFs and
  documents → an attachment.
- Outside the grants: files → a one-time read-only snapshot (`outsideGrant: true`).
  Folders → refused with `grant-folder` (grant it in Settings → Folders).
- Kinds and binary refusal are decided in one place, `classifyAttachment`
  (`src/main/attachments/classify.ts`), by content only (magic bytes and container
  entries, never the name). Per-kind limits are `KIND_LIMITS` there.
  - `image`: model-ready formats (`MODEL_IMAGE_MIMES`). Over 1568px they are scaled with
    Electron's `nativeImage` (PNG/JPEG; a bigger GIF/WebP is refused).
  - `pdf`: page count is best effort (the page tree's `/Count` when stored uncompressed,
    otherwise only the size limit applies).
  - `document`: originals that need extraction, stored as they are (up to 50 MB). Zip
    packages are recognised by their central directory (the end record found from the end
    of the file, every entry bounds-checked, at most 10,000 entries; ZIP64, multi-disk,
    duplicate names and inconsistent records refused): Office Open XML needs real
    `[Content_Types].xml` and `word/document.xml`, `xl/workbook.xml` or
    `ppt/presentation.xml` entries; OpenDocument a stored `mimetype` first entry naming an
    `application/vnd.oasis.opendocument.*` type. Also legacy Office and Outlook `.msg` (OLE2 by root class id or stream name;
    `.msi` and unknown compound files are refused), RTF, `.eml` (a mail header block),
    and HEIC/HEIF/AVIF/TIFF/BMP images. When the first 8000 bytes do not decide a
    container, the classifier asks for more of its start or end (up to 1 MB each), read
    through the same verified handle.
  - `text`: anything else passing read_file's binary check; stored as UTF-8.
  - Other zips (jar, apk, epub, vsix), executables and binaries are refused.
    Extraction happens when a chat is sent (`docs/document-reader.md`).
- The 20 MB per-message total is the composer's to enforce (main sees one file at a time).

## Checks (`validate.ts`)

Empty or over-long paths, network (UNC), device and stream paths, quote/control/bidi
characters, secret names (`isSecretName`), the built-in blocklist and the app's own data
are refused on the path as given and again on its real path. A final link or junction is
never followed; links further up are resolved and the real path is checked. Hard links,
devices, pipes and sockets are refused. Files are read through a handle opened without
following links and matched to the checked device/inode.

## Store

`userData/attachments/<sha256>` (`store.ts`). Ids are checked against
`ATTACHMENT_ID_PATTERN` before any path join; writes go to an owner-only temp file and are
renamed into place; `read` returns null if the bytes no longer match the id. `release(ids)`
deletes blobs outright, with no reference counting. Because the store is content-addressed,
identical bytes attached in several chats are one blob under one id, and releasing it
removes it for all of them: callers must only pass ids that no saved chat references any
more. `sweep(keep,
minAgeMs)` removes unreferenced blobs and stale temp files, and sidecars whose blob is gone;
all under the same `minAgeMs` age rule.

Metadata: `issue(bytes, meta)` stores the blob and writes `<id>.json` next to it (same
atomic, owner-only write) with the `AttachmentRef` main issued (name, kind, mime, size,
source). `describe(id)` re-validates the sidecar on every read (zod, at most 4 KB, plain
file, id and size must match the blob) and returns null for anything else. A blob stored
again under another name keeps one sidecar, holding the latest metadata. `isIssued(id)` is
true only for ids this session issued via drop, picker or paste, plus ids saved chats
register with `registerIssued(ids)`; `release` and `sweep` forget them. The type the
conversation and provider code use is `AttachmentBlobs` (`has`, `read`, `release`,
`describe`, `isIssued`); `createAppServices` returns the store as `attachmentStore`.

## Audit

One entry per attempt: `tool: 'attach'`, `origin: 'user'`, `args: { source, kind, mime,
size, inGrant }`, the real path, and on refusal `error` (`secret`, `blocked`, `too-large`,
`binary`, `link`, `not-found`, `invalid`, `grant-folder`, `too-many`, `failed`). Copies are
audited as `tool: 'copy_into_folder'` with the approval answer. Never file contents.

## Wiring and startup

`createAppServices` builds one `AttachmentStore` under `userData/attachments` and passes it to the chat session (`attachments: AttachmentStoreLike`, replaced only by tests) and to the attachments service; it is returned as `attachmentStore`. When a saved chat is loaded (startup, opening a chat), `unavailableAttachments` calls the store's `registerIssued(ids)` with the ids it references, so sending, retrying or forking that history works after a restart.

At startup, before the window can send, `sweep` removes blobs no saved chat (of any connection) or the open conversation references, and only those older than a day. It is skipped entirely when any chat file cannot be read, since its references are unknown (the same rule as `release`).

## Composer (renderer)

`src/renderer/src/attachments/` holds the pure rules (`model.ts`: limits, refusal wording, which kinds a connection can receive) and the `useAttachments` hook; `components/AttachmentChips.tsx` draws chips.

- Chips above the text show a kind icon (or a preview of a dropped or pasted image: a `blob:` object URL of the user's File, revoked when the chip is removed, the draft is sent or cleared, or the composer unmounts; the sent message shows the kind icon), the name (middle-truncated, in a `<bdi>`), size and a remove button. A chip is dashed and grey, with a tooltip, when the connection cannot receive its kind (`canReceive`): text files always reach the model inline; images reach it when main says the connection's current model can see images (`connections.vision`, re-read when the connection, the model or "This model can see images" changes; see `docs/provider-images.md`); PDFs, and Word, Excel, PowerPoint and OpenDocument files (and Word and Excel 97-2003, by the MIME type main recorded: `READABLE_DOCUMENT_MIMES`), always reach it as the text the document reader extracts; other documents (older PowerPoint, RTF, mail) are still sent as their names only.
- Drop (chat column and message box), paste and the paperclip all end in `files.attachDropped`, `attachments.fromPaste` or `attachments.pick`. The Files tab shows a hint pointing to the message box and attaches nothing; tree-token drags still insert `@` references.
- An `@"path"` outcome is inserted into the text; refusals are toasts (one line for a batch), with an "Open Settings" button for `grant-folder`. A snapshot from outside the grants offers "Copy into folder…", which uses the first granted folder and main's approval dialog.
- The composer enforces 10 files and 20 MB per message before send; `send(text, attachmentIds)`. Attaching is paused exactly when sending is (a reply is running, or the chat is switching). Esc and approvals are unchanged.
- Sent messages show the same chips read-only; a missing blob shows "Attachment no longer available". Retry resends the available attachments.
