# Links and file names in chat replies

A reply is untrusted: the agent reads untrusted documents, and file names are chosen by whoever made the file. Two things in a reply can be clicked.

## Web links

- Hover or keyboard focus shows where the link really goes: the target in strict left-to-right order with hidden, direction and look-alike characters shown as `⟨U+XXXX⟩` tokens (the approval dialogs' helpers in `reveal.tsx`), and the host as the browser reads it (non-ASCII hosts as punycode).
- When the visible text reads as a web address (`https://example.com`, `www.example.com`, `example.com/x`) whose host differs from the real host, a click asks first, naming the real destination. The check runs before anything opens; Enter, middle click and Ctrl+click are held the same way. Text that is not an address (`README.md`) or names the same host (a leading `www.` aside) does not ask.
- Opening still goes through the main process's window-open handler, which opens only `http(s)` (`src/main/window.ts`). That rule is the final authority (`src/main/web-link-rule.ts`): the target must start with `http://` or `https://` in any letter case (`HTTPS://example.com` is fine), contain no whitespace or control characters, and parse as a URL with an `http:` or `https:` protocol. Everything else (other schemes, `https:example.com`, a leading or trailing space, malformed text) is refused. What reaches the browser is the parsed form. A URL with credentials (`https://user:pw@host/`) is accepted like any other; the real host is the one after the `@`, which is what the hover and the mismatch check show.
- **Right-click** in the app shows a native menu with Open Link and Copy Link Address for `http(s)` links. Open Link follows the same rule as a click: the mismatch check (`src/shared/web-link-mismatch.ts`, one pure module used by the page and by the main process) is run in the main process on the link text and target that Chromium reports for the element under the cursor (`params.linkText`, `params.linkURL`), never on anything the page sends over IPC. On a mismatch a native confirmation (attached to the window) names the claimed and the real host and shows the target in parsed form: ASCII only, host as punycode, any other character as a `⟨U+XXXX⟩` token. **Cancel is the default** (Enter and Esc cancel). Copy Link Address needs no confirmation.
- **While an approval is open**, the main process knows (it holds the pending approvals, `ChatSession.pendingApprovals`) and Open Link is not in the menu; a menu already on screen when an approval arrives does nothing when clicked, and an approval that arrives while the confirmation is up cancels the open. The modal overlay would not be a reliable guard here, because the native menu is not part of the page.
- Markdown settings are unchanged: raw HTML skipped, images never load, unsafe schemes (`javascript:`, `data:`, `file:`) stripped. A `file:` URL never becomes a link.

## Files and folders

The renderer only proposes text; the main process decides (`src/main/files/mention.ts`) through two channels, `files:resolve-mentions` (what would a click do?) and `files:open-mention` (do it), both behind the app-only sender check, taking only bounded strings.

### What a click does

| What the reply names                      | Click                                                         |
| ----------------------------------------- | ------------------------------------------------------------- |
| A folder inside a granted folder          | Opens it in Explorer                                          |
| A file of an allowed passive type (below) | Opens it with its default app (`shell.openPath`)              |
| Any other file                            | Shows it in Explorer (`shell.showItemInFolder`); never opened |
| Anything else (see "Plain text" below)    | Nothing: it stays plain text                                  |

Allowed types (`OPEN_EXTENSIONS`): `txt md csv tsv log pdf png jpg jpeg gif webp bmp docx xlsx pptx odt ods odp`.

Everything else is only shown, including macro-capable Office files (`docm xlsm pptm dotm xlsb xls doc ppt`), launchers and scripts (`exe bat cmd ps1 lnk url scr msi js vbs hta jar com reg`), `svg` and `html`, `rtf`, archives, files with no extension, and unknown types. The type comes from the REAL name the file system reports (after resolving), compared in ASCII lower case, so `A.TXT` opens, and `a.txt.exe`, `a.txt.lnk`, `a.txt.` and `a.txt:stream` do not. The tooltip and the toast say when a file is shown rather than opened. The error string `shell.openPath` returns is shown to the user.

### Plain text

Text stays plain, with no click and no reason given to the reply (every refusal looks the same), when it is:

- not inside a granted folder (compared as text before any file is touched, so paths outside the grants are never probed), or not an existing entry;
- reached through a symlink, junction or 8.3 short name (nothing is followed, even inside a grant), or a network, device, drive-relative or `..` path;
- a name with an alternate data stream (`a.txt:evil`) or a trailing dot or space;
- a hard-linked file (the agent's tools refuse them too);
- a secret file (`.env`, `secrets.json`, ... the Files panel's lock list) or on the agent's blocklist, or inside the app data folder;
- spelled with control or direction characters.

Every click is checked again at click time against the grants as they are then. Every attempt (opened, shown, failed or refused) is an audit entry (`tool: open_from_reply`, `origin: user`: action, kind and path, never contents).

A trailing `:42` or `:42:7` (a line reference, as `grep` prints) is dropped before checking; the hover shows the file that will open.

### What the renderer proposes

Conservative, on purpose (every proposal is a question to main):

- whole inline code (`` `C:\Users\me\a.pdf` ``, `` `src/app.ts` ``, `` `notes.md` ``);
- whole link targets: `[x](docs/a.md)`, `[x](C:\Users\me\a.pdf)` (a drive path is kept only as data and never becomes an `href`);
- a whole paragraph, list item or table cell that is a path (spaces allowed), and each line of a fenced block with no language;
- quoted paths in prose (`"C:\My Docs\a.txt"`);
- words in prose that are unmistakably paths: a drive letter, or a separator plus a file extension or a closing slash.

Missed: a path with spaces written bare in prose (the agent is asked to put full paths in backticks), a bare file name in prose, a folder named only by its name, tree drawings (`├──`) and `dir` output, and a name that exists in more than one granted folder (it is not guessed).

### While an approval is open

Nothing in a reply opens while an approval is showing (`LinksSuspended`): clicks are held and the link confirmation is hidden and inert, like the other app dialogs.

## Limits

- Opening a **parent folder** in Explorer can show the names of secret files inside it (`.env`, `secrets.json`, ...). The file names appear in the listing; their contents are not read or sent anywhere. This is a known limit, the same as Explorer itself.
- The check and the open are not one atomic step: a file swapped between them is a race the guard cannot close.
- `docx`, `xlsx` and `pptx` are on the list as passive types, but Office can still follow external links or formulas in them, as when the user opens any such file.
