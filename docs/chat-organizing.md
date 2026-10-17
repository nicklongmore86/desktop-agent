# Projects, pins, archive and fork

The chat list's sections (Pinned, Projects, Chats, and the Archived filter) and the
per-chat actions. IPC: `src/shared/ipc-projects.ts` (the `projects:*` channels, a
per-feature module, see `ipc-modules.md`); main: `src/main/chat/organizer.ts`.

## Where things are stored

**Chats** stay where they were: one history per provider,
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

## Other providers' chats

A project can hold chats of several providers. The open provider's chats come with the
chat history; other providers' chats are listed only when pinned or filed in a project.
Opening one switches provider first, through the same switch as Settings (a running
reply is stopped and its approvals denied), and then opens that chat.

## Fork

All three providers rebuild the model's context from the saved messages on every send,
so a fork is a copy of the saved chat file into a new chat ("Fork of …") in the same
provider, with `forkedFrom` set and the same project. It copies messages and tool
results, as text. Approvals are never copied (none are saved). Forking from a prompt
keeps that many prompts and their full replies; the cut is always just before a prompt,
so a tool call is never separated from its result, and the copy is checked with the
same well-formedness rules as a loaded chat.

Forking a chat that belongs to another provider (reached through Pinned or Projects)
copies it within that provider, then switches the active provider to open the fork,
exactly as opening that chat would. The switch is needed because the renderer only shows
and sends to the active provider's chat, so the new chat could not be opened otherwise;
like any switch it stops a running reply and denies its approvals.
