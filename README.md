# desktop-agent

A Windows-first desktop chat agent, powered by Claude, with permissioned access to your local files and shell.

## Goals (v1)

- **Platform:** Windows 10/11 first (Electron + TypeScript); macOS/Linux later.
- **Model:** Claude via the Anthropic API (user-supplied key stored with OS-level encryption). Provider layer kept pluggable so a local model (Ollama) can be added later.
- **Capabilities:** full file access (list, read, search, write, move, delete) within user-granted folders, plus shell commands (PowerShell/cmd).
- **Safety model:**
  - Access limited to explicitly granted root folders; a hard denylist always blocks secrets (`~/.ssh`, `.env*`, credential/key stores, browser profiles, etc.).
  - Every write/move/delete shows a preview (diff) and requires user approval.
  - Every shell command requires user approval (with "always allow this exact command" option).
  - Append-only audit log of every tool call.
- **UI:** desktop chat window with streaming responses and inline approval prompts.

## Roadmap

1. Scaffold: Electron + TS + React (Vite), lint/typecheck/test, Windows packaging, CI.
2. Core: permission/sandbox layer + file tools + shell tool, with tests.
3. Agent loop: Claude tool-use loop, provider abstraction, key storage.
4. Chat UI: streaming chat, approval dialogs, settings (folders, key).
5. Packaging: signed-ish Windows installer, auto-update later.

## Development

The app is a skeleton for now: one window with a placeholder chat UI and no agent logic yet.

### Prerequisites

- Node.js 24 (CI uses 24.18.1)
- pnpm 12.4.2. The version is pinned in `packageManager`; run `corepack enable` or install pnpm 12.4.2 yourself.
- Windows 10/11 to build the installer. Linux and macOS can run the dev, test and build scripts, but `electron-builder --win` needs Wine there.

### Quickstart

```sh
pnpm install       # install dependencies (CI runs: pnpm install --frozen-lockfile)
pnpm dev           # start the app with hot reload
pnpm test          # run unit tests (vitest)
```

Other scripts:

| Script              | What it does                                         |
| ------------------- | ---------------------------------------------------- |
| `pnpm typecheck`    | Strict TypeScript check of main/preload and renderer |
| `pnpm lint`         | ESLint (typescript-eslint, react-hooks)              |
| `pnpm format`       | Format all files with Prettier                       |
| `pnpm format:check` | Check formatting without writing                     |
| `pnpm build`        | Compile main, preload and renderer into `out/`       |
| `pnpm start`        | Run the compiled app from `out/`                     |
| `pnpm dist:win`     | Build, then create the Windows NSIS installer        |

### Building the Windows installer

```sh
pnpm dist:win
```

This writes `release/<version>/Desktop-Agent-Setup-<version>-x64.exe`, an x64 NSIS installer that installs per user and lets you choose the install directory. CI builds the same installer on `windows-latest` and uploads it as the `desktop-agent-windows-x64` workflow artifact.

**The installer is not code-signed yet.** Windows SmartScreen will warn about an unrecognised publisher when you run it. Signing is planned for the packaging milestone.

### Layout

```
src/main       Electron main process: window creation, security hardening, IPC handlers
src/main/permissions  Granted folders, path guard, blocklist, audit log
src/main/tools        The agent's file and shell tools (createTools)
src/preload    contextBridge API exposed to the renderer as window.desktopApi
src/renderer   React UI (Vite)
src/shared     Code and types used by more than one process (IPC contract, CSP)
```

### Security baseline

- Renderers run with `contextIsolation`, `sandbox` (also enforced app-wide via `app.enableSandbox()`), `nodeIntegration: false`, `webSecurity` on, and `<webview>` disabled.
- The renderer gets a narrow typed API through `contextBridge`, never `ipcRenderer` itself. IPC handlers reject calls from frames outside the app.
- A strict Content-Security-Policy (`default-src 'none'; script-src 'self'; …`) is injected into `index.html` at build time, so no remote scripts load. In dev mode it is relaxed only as far as Vite's dev server needs (inline scripts and styles, plus the HMR websocket).
- `window.open` is always denied (http(s) links open in the default browser). Navigation and redirects away from the app are blocked, and permission requests (camera, notifications, …) are denied.
- The app loads no remote content: only the bundled renderer, or the local Vite dev server during `pnpm dev`. `ELECTRON_RENDERER_URL` is ignored in packaged builds and must be a loopback `http://` URL otherwise. The `file://` allow-list also checks the host, so UNC paths (`file://server/share/...`) are rejected.

### Permissions and tools

The agent touches the machine only through the tools in `src/main/tools`, and every tool goes through the permission layer in `src/main/permissions`. Wiring, for the agent loop:

```ts
const userData = app.getPath('userData')
const grants = await GrantStore.open(join(userData, 'grants.json'), { protectedPaths: [userData] })
const guard = new PathGuard({ roots: () => grants.list(), protectedPaths: [userData] })
const tools = createTools({
  guard,
  audit: new AuditLog(join(userData, 'audit.jsonl')),
  trash: (path) => shell.trashItem(path),
  onAuditFailure: () => {
    /* show a "logging is broken" warning; AuditLog.healthy says the same */
  },
})
```

| Tool           | Does                                                                              | Approval                    |
| -------------- | --------------------------------------------------------------------------------- | --------------------------- |
| `list_dir`     | Entries with type, size, mtime; optional depth (max 5), at most 1000 entries      | no                          |
| `read_file`    | Text up to 1 MB (or a line range of a bigger file); refuses binary files          | no                          |
| `search_files` | Name glob and/or content substring/regex; result, depth, entry and 10 s time caps | no                          |
| `write_file`   | Create or replace a file; diffs over 256 KB are refused                           | always, with the full diff  |
| `move_file`    | Move or rename within the grants                                                  | always                      |
| `delete_path`  | Send to the Recycle Bin (never a permanent delete)                                | always                      |
| `run_shell`    | PowerShell (`-NoProfile -NonInteractive -Command`) on Windows, `/bin/sh -c` else  | always, exact command + cwd |

Tools never throw: a refused path, a declined approval, bad input or even a failing audit sink comes back as a normal result (`{ isError: true, content }` for failures), and a declined approval has no side effect.

`search_files` with only a name pattern lists matching names of any file, binary or not; content matches never come from binary files, files over 1 MB or hard-linked files. Glob and regex matching runs in a worker thread that is terminated at the search's time cap or when the call is cancelled, so a catastrophic pattern like `(a|aa)+$` cannot freeze the app.

**Granted folders.** The user grants folders (stored as real paths in `grants.json`); a drive root, a blocklisted folder or the app's own data cannot be granted. A path is allowed only when its real location is inside a granted folder: symlinks and junctions are resolved, and for a path that does not exist yet, the nearest existing parent is resolved. Windows comparisons ignore case. Rejected outright: relative paths, network (UNC) paths, `\\?\` and `\\.\` device paths, NTFS alternate data streams (`file:stream`), reserved device names (`CON`, `NUL`, `COM1`, `nul.txt`...), names ending in a dot or space (Windows strips them), and links whose target is missing (a write would create the target wherever it points). Windows 8.3 short names (`ENV~1.PRO` for `.env.production`) are expanded to the long name before any check, including for move and delete, which act on an entry without following it; a short alias of a link is refused. Regular files with more than one hard link are refused for reading, content search, writing, moving and deleting, since another name may live outside the grants. A grant whose folder is later replaced by a link stops working.

**Blocklist.** Always applied, even inside a granted folder, case-insensitively, to every segment of the path, and not configurable: `.ssh`, `.gnupg`, `.aws`, `.azure`, `.kube`, `.docker/config.json`, `.env` and `.env.*`, `*.pem`, `*.key`, `*.pfx`, `*.p12`, `*.kdbx`, `id_rsa*` / `id_dsa*` / `id_ecdsa*` / `id_ed25519*`, `.npmrc`, `.netrc` / `_netrc`, `.git-credentials`, Chrome / Edge / Brave / Chromium `User Data` and Firefox profiles, Windows Credential Manager, DPAPI (`Protect`), `Crypto` and `Vault` folders under `AppData`, and the app's own userData (grants, audit log, key store). Directory listings and searches hide blocked entries; moving or deleting a folder that contains one is refused.

**Audit log.** `audit.jsonl` gets one line per tool call: timestamp, tool, an argument summary, the resolved paths, approval (`auto`, `approved`, `denied`, `not-requested`), outcome, duration and, for failures, a short error category (`access-denied`, `declined`, `changed`, `hard-link`, `timeout`, `kill-failed`, a Node code like `EACCES`...), never the error message. It never contains file contents (writes log only the byte count). Search patterns are logged only as kind, length and flags. Shell commands are the exception, on purpose: the exact approved command and cwd are the core of the audit trail, so they are logged in full, with token-like strings (`sk-...`, `ghp_...`, `password=...`) masked. The log lives in userData, which the agent's tools can never read. If writing the log fails, the tool call still completes, `onAuditFailure` is called and `AuditLog.healthy` turns false.

**Threat model.** The model is treated as untrusted: it may be steered by prompt injection in files it reads. The guard is what stops it reading secrets or touching anything outside the grants without asking; approvals are what stop it changing anything without the user seeing the change first. Known limits:

- `run_shell` is not sandboxed. Its cwd must be inside a grant, but the command itself can do anything the user can; the approval prompt showing the exact command is the only control. PowerShell and taskkill are started by absolute path under `%SystemRoot%` (and `/bin/sh` elsewhere), never looked up in the cwd or on `PATH`, and the approval shows that path. Right before spawning, the cwd is re-resolved through the guard and must still be granted and the same folder (device + inode) the user approved. The child gets the app's environment minus `ANTHROPIC_*` and `ELECTRON_*` variables.
- What is approved is bound to what was reviewed: `write_file` records the file's existence, inode, size, mtime and SHA-256 when it builds the diff and refuses the write if any of them changed by the time the user approves; new files are created exclusively (`O_EXCL`).
- Time-of-check/time-of-use, best effort within Node's limits: Node has no `openat()`-style handle-relative API, so a concurrent local process can still race a path between the check and the use. The tools narrow that window: files are opened (with `O_NOFOLLOW` on POSIX), the open handle is `fstat`ed and must be a single-link regular file with the same device and inode the guard checked, the path is re-guarded after opening, and every read and write goes through that handle. Directory walks re-check each folder (still a real folder, same inode, real path unchanged) just before listing it. A local process that can win these races already runs as the user, so this protects against confusion rather than a determined local attacker. The model itself cannot create links or swap files except through an approved shell command.
- Killing a cancelled or timed-out command: on POSIX the shell's whole process group gets SIGKILL. On Windows, `taskkill /T /F` kills the tree; its exit code is checked, and if it fails (or the shell does not exit within 5 s) the result says the process tree may still be running instead of claiming it was killed. A process that detaches from the tree (for example a grandchild whose parent already exited) can escape `taskkill /T`.
- Matching a regex is bounded by the search time cap but still costs CPU in a worker thread until it is terminated.

Follow-ups (not done yet): run commands with an allowlisted environment instead of the app's environment minus a denylist; contain Windows commands in a Job Object (needs a native addon) so no descendant can outlive a kill.
