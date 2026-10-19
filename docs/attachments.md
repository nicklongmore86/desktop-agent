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
  `referenceFor`, no size limit: the agent reads it with its tools). Images and PDFs →
  an attachment.
- Outside the grants: files → a one-time read-only snapshot (`outsideGrant: true`).
  Folders → refused with `grant-folder` (grant it in Settings → Folders).
- Kinds and binary refusal are decided in one place, `classifyAttachment`
  (`src/main/attachments/classify.ts`), by content only. Per-kind limits are `KIND_LIMITS`
  there. Text is stored as UTF-8. Images over 1568px are scaled with Electron's
  `nativeImage` (PNG/JPEG; a bigger GIF/WebP is refused). PDF page counts are best effort:
  the page tree's `/Count` when stored uncompressed, otherwise only the size limit applies.
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
deletes blobs (callers must only release ids no saved chat refers to); `sweep(keep,
minAgeMs)` removes unreferenced blobs and stale temp files.

## Audit

One entry per attempt: `tool: 'attach'`, `origin: 'user'`, `args: { source, kind, mime,
size, inGrant }`, the real path, and on refusal `error` (`secret`, `blocked`, `too-large`,
`binary`, `link`, `not-found`, `invalid`, `grant-folder`, `too-many`, `failed`). Copies are
audited as `tool: 'copy_into_folder'` with the approval answer. Never file contents.
