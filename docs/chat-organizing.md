# Projects, pins, archive and fork

The chat list's sections (Pinned, Projects, Chats, and the Archived filter) and the
per-chat actions. IPC: `src/shared/ipc-projects.ts` (the `projects:*` channels, a
per-feature module, see `ipc-modules.md`); main: `src/main/chat/organizer.ts`.

## Where things are stored

**Chats** stay where they were: one history folder per home connection,
`userData/history/<provider>/index.json` plus `<id>.json` per chat. Each index entry
gains optional fields (index format 2):

| Field        | Meaning                                                                       |
| ------------ | ----------------------------------------------------------------------------- |
| `pinnedAt`   | Pinned at this time (ms). Pinned chats list oldest pin first.                 |
| `archivedAt` | Archived at this time (ms): hidden until restored. Never deletes anything.    |
| `projectId`  | The project the chat is filed in. A project that no longer exists: unfiled.   |
| `forkedFrom` | `{ id, atMessageIndex }`: the source chat, and the messages kept (null: all). |

The index keeps `version: 1` on disk and adds `format: 2`, because the previous build
accepts only `version: 1` (anything else makes it rebuild its list from the chat files,
losing renamed titles). That build's parser drops the new fields, so it still lists
every chat with its title; if it then saves, the new fields are gone, nothing else.
A format-1 index reads as format 2 with every new field unset and is upgraded on the
next change. An invalid new field reads as unset; it never makes the index unreadable.
An index that cannot be read at all is rebuilt from the chat files (as before), which
loses the new fields and renamed titles; projects are in their own file and survive.

**Projects** are global (one list for every provider): `userData/projects.json`,
`{ version: 1, projects: [{ id, name, icon }] }` in display order. An unreadable file is
renamed to `projects.json.unreadable` before the first write, never overwritten.

Every change to an index or to `projects.json` goes through that store's write queue
(writes never overlap) and is written atomically; a failed write puts the change back.

## Ids and paths

Chat and project ids are random v4 UUIDs made in main. Main builds a path only from an
id that matches that pattern; the IPC handlers refuse anything else (and any provider
that is not one of the three) before it reaches a store.

## One list for every connection

The sidebar shows **one shared list**: `HistoryState.chats` holds every registered
connection's chats (hidden personal-use and removed connections included), newest first,
archived ones too. Each has its **home** connection (`provider`, the folder it is saved
in, which never changes) and, once it has a reply, `lastConnection` (the connection that
answered last). Pinned, Projects, Chats (by date) and the Archived filter all work over
that merged list; a project can hold chats of any connection.

- A row's badge is `lastConnection`, or the home until the chat has a reply, by the
  connection's short name (plain text; an id main no longer lists is shown as its id).
- The open chat is `HistoryState.active` (home + id), so two chats with the same id in
  different homes are never confused. `null` is a new chat that is not saved yet.
- Every row action (open, rename, delete, pin, archive, move, fork, drag and drop, Undo)
  takes a `ChatRef` (`{ provider: home, id }`).
- **Opening a chat never switches connection.** `projects.chats.open(ref)` continues the
  chat on the connection that is current; a running reply is stopped first (its approvals
  are denied), like any switch of chat.

## Switching connection with a chat open

Picking another connection in the composer (or Settings) **continues the open chat on it**.
The renderer's switch kind `'connection'` keeps the messages and the list on screen,
shows "Switching to <connection>…" (the input is read-only meanwhile), and ignores events
from the old run until main's `conversation_reset` **for the same chat** arrives (a reset
for another chat is not its own). History pushes (`history_changed`) are applied live in
the meantime. If the switch fails, the chat main still has open is shown again, with the
list untouched. A reply running when the picker changes is stopped ("stop and switch").
"New chat" starts on the current connection and clears the screen, as before.

## Provider badges on replies

Each saved reply carries the connection (and model, when known) that wrote it. The chat
shows a badge (connection and model, as plain text) on the first reply, and only on the
replies where the connection or the model differs from the previous reply. A reply with
nothing recorded (saved before it was) gets no badge and does not move the comparison.
A reply streamed in the open window is stamped with the connection and model it started on.

## Fork

All three providers rebuild the model's context from the saved messages on every send,
so a fork is a copy of the saved chat file into a new chat ("Fork of …") in the same
provider, with `forkedFrom` set and the same project. It copies messages and tool
results, as text. Approvals are never copied (none are saved). Forking from a prompt
keeps that many prompts and their full replies; the cut is always just before a prompt,
so a tool call is never separated from its result, and the copy is checked with the
same well-formedness rules as a loaded chat.

Forking a chat copies it within its home connection, and the fork then opens on the
current connection, exactly as opening any chat does (no switch of connection). Like any
open it stops a running reply and denies its approvals.
