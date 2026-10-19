# Attachments in saved chats

How a prompt's attached files are saved, sent to models, forked and cleaned up. The files themselves are held by the attachment store (`userData/attachments/<id>`); a saved chat only references them.

## Saved-chat format

A user prompt with attachments is saved as an array: its text (if any) as a `text` block, then one block per file, in order:

```json
{
  "type": "attachment",
  "id": "<64 lowercase hex>",
  "name": "notes.md",
  "kind": "text",
  "mime": "text/markdown",
  "size": 1200
}
```

The fields are `AttachmentRef` (`src/shared/attachments.ts`). An attachment derived from another one (a rendered PDF page, say) also has `source: { id, page?, region? }`. A prompt without attachments is still saved as a plain string, exactly as before.

Loading checks every block strictly (`src/main/storage/conversation-store.ts`):

- exactly these six fields (plus an optional `source`), nothing else;
- `id` matches `ATTACHMENT_ID_PATTERN`; `kind` is `text`, `image`, `pdf` or `document`;
- `name` is what `sanitizeTitle` keeps unchanged (no control, bidi or zero-width characters, single spaces, trimmed), at most 255 characters, with no `/` or `\`;
- `mime` is a bare `type/subtype`. Images must be one of `MODEL_IMAGE_MIMES` (JPEG, PNG, WebP, GIF), PDFs `application/pdf`. Documents must be Office (Word, Excel, PowerPoint, OOXML), OpenDocument, RTF, mail (`message/rfc822`, Outlook), or an image a model cannot read as-is (HEIC/HEIF, TIFF, BMP);
- `source`, when present: `id` matches the pattern and is not the attachment's own; `page` is a positive whole number; `region` is exactly `{x, y, width, height}`, each a finite number ≥ 0; no other fields;
- `size` is a whole number within the kind's limit (documents: `documentBytes`);
- only in user prompts (never in assistant messages or next to tool results), at most 10 per prompt, no id twice, 20 MB in all.

A chat that fails any check is unreadable, like any other malformed chat file.

## Older chats and older app versions

- Chats saved before attachments existed load unchanged.
- An older app version does not know the `attachment` block, so it treats a chat containing one as unreadable: the chat lists as "Unreadable chat" (or shows "could not be read" when opened) and cannot be forked there. If the user then sends a message in that chat in the older version, the older version saves a new conversation over it and the attachment references are lost. Chats without attachments are unaffected. Upgrading again reads every chat the older version did not overwrite.

## Sending

`ChatSession.send(text, attachments?)` checks the renderer's references again in main: the exact shape above, the per-message limits, and that the store still holds each id (`has`). Nothing is saved or run unless every check passes. A prompt may be files only.

## What models receive

Before a run, `toModelConversation` (`src/main/chat/attachments.ts`) turns every attachment block into a text block, for every provider (Claude API, Claude and Codex subscriptions, ChatGPT plan, OpenAI-compatible, Gemini):

- a text file the store can `read` is inlined in a fenced block, introduced as user-provided, untrusted file data; the fence is longer than any backtick run in the file;
- anything else (images, PDFs and documents, until extraction and per-provider translators land) is the placeholder `[Attached file (user-provided, untrusted): name, kind, size — not sent to this model yet]`;
- a file the store no longer holds is `[Attachment no longer available (user-provided, untrusted): …]`.

The saved history keeps the attachment blocks; only the request copy is translated.

## Missing files

When a chat is opened, each referenced id is checked with `has`. A missing file never stops the chat loading: its attachment shows with `available: false` (the view shows "Attachment no longer available") and models get the placeholder above.

## Forks and deletes

A fork copies the attachment blocks with the rest of the history; fork points still never split a tool call from its result. When a chat file is deleted, the ids it referenced are offered for release: the store's `release` is called only with ids that no saved chat of any connection (including forks) and not the open conversation still references. Chat files are read loosely for this, so a chat this version cannot load still keeps its files.
