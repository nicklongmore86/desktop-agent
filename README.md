# desktop-agent

A Windows-first desktop chat agent with Anthropic API, Claude subscription, and Codex subscription access to permissioned local file and shell tools.

## Goals (v1)

- **Platform:** Windows 10/11 first (Electron + TypeScript); macOS/Linux later.
- **Providers:** Anthropic API (encrypted API key), Claude subscription (official Claude Agent SDK), or Codex subscription (official app-server with ChatGPT-managed authentication).
- **Capabilities:** full file access (list, read, search, write, move, delete) within user-granted folders, plus shell commands (PowerShell/cmd).
- **Safety model:**
  - Access limited to explicitly granted root folders; a hard denylist always blocks secrets (`~/.ssh`, `.env*`, credential/key stores, browser profiles, etc.).
  - Every write/move/delete shows a preview (diff) and requires user approval.
  - Every shell command requires user approval.
  - Append-only audit log of every tool call.
- **UI:** desktop chat window with streaming responses and inline approval prompts.

## Roadmap

1. Scaffold: Electron + TS + React (Vite), lint/typecheck/test, Windows packaging, CI.
2. Core: permission/sandbox layer + file tools + shell tool, with tests.
3. Agent loop: Claude tool-use loop, provider abstraction, key storage.
4. Chat UI: streaming chat, approval dialogs, settings (folders, key).
5. Packaging: signed-ish Windows installer, auto-update later.

## Windows: test subscriptions without an API key

1. Download the **desktop-agent-windows-x64** artifact from this PR's successful **CI → Windows installer** job. Extract the ZIP and run the NSIS `.exe`. The installer is unsigned. Alternatively, use the development commands below on Windows.
2. Both pinned native runtimes are included: Claude Code **2.1.299** and Codex **0.162.1**. No Node.js, npm, API key, or separate CLI installation is required on the user's machine. The installed app runs only its own bundled executables, after checking every runtime file against SHA-256 digests compiled into the app; it never falls back to a CLI on PATH, so an older or modified copy cannot replace the bundled version. These are intentional protocol/security pins.

3. Open **Settings → Access provider**, select **Claude subscription** or **Codex subscription (ChatGPT)**, then **Sign in with subscription**. Complete the provider's browser flow using a plan that includes runtime access. Do not choose Anthropic Console/API billing. Use **Check readiness** afterwards. Do not enter an API key or use `setup-token`.
4. Sign-in is separate from your normal CLI profile. The official runtime stores and refreshes its own credentials under the app's `providers/claude` or `providers/codex` directory. Desktop Agent does not extract, copy, return, or substitute tokens. **Cancel sign-in**, window close/reload, and provider switching cancel login. Login expires after five minutes.
   **Claude sign-in:** your browser opens to the Claude sign-in page. If it does not, Settings shows the sign-in link with **Copy** and **Open in browser**; open it yourself, authorize, and if the page shows a code, paste it into **Paste code** and choose **Submit code**. The app only opens links to `claude.com`, `claude.ai` or `platform.claude.com` over https, and only accepts codes of the form `code#state`. The runtime may also try to open the browser itself, so you can occasionally see two identical tabs; complete either one. Failures show the runtime's error message in Settings. Only one sign-in runs at a time: **Sign in with subscription** stays disabled while one is waiting, and closing and reopening Settings shows the same link, code field and **Cancel sign-in** again.
5. Grant a disposable folder containing `hello.txt`. Ask the agent to read it, then change it. Verify a diff approval appears; deny it and confirm the file is unchanged. Approve a second change and inspect the audit log. Ask for an ungranted file and a `.codex/auth.json` file: both must be refused. Stop a streamed reply, switch providers, and restart the app: each provider's previous conversation should return separately.

Damaged/missing bundled runtime (repair or reinstall the app), unsupported version/configuration, and signed-out states are shown in Settings. Expired authentication and usage-limit errors appear in chat; reauthenticate or wait for the plan allowance to reset. Subscription failures never fall back to API billing. Switching back to **Anthropic API** restores the original API conversation and model setting.

**Verification limits:** automated tests run the pinned native runtimes without credentials on Linux and Windows CI, including paths with spaces and hostile configuration fixtures. They verify startup/protocol isolation, not a paid subscription response. Browser sign-in, actual plan eligibility/limits, a live tool round trip, and interactive installer use still require the manual steps above. The app's approved shell tool remains an unsandboxed user-authorized command, as in API mode; approval is not an OS sandbox.

## Subscription implementation and distribution notes

- Claude uses `@anthropic-ai/claude-agent-sdk` **0.3.299** with Claude Code **2.1.299**, an in-process custom MCP bridge to `createTools`, `tools: []`, strict MCP configuration, empty settings sources, disabled project instructions/auto-memory, disabled hooks, and no project/skill/plugin discovery. Input is withheld until account metadata indicates a subscription and no API-key source. Unexpected built-in tools fail closed. [SDK overview](https://code.claude.com/docs/en/agent-sdk/overview), [CLI isolation flags](https://code.claude.com/docs/en/cli-reference), [authentication](https://code.claude.com/docs/en/authentication).
- Codex uses **0.162.1** stdio app-server, experimental dynamic tools and `environments: []`, explicit feature controls (including the execution host needed to dispatch app-owned dynamic tools), an isolated `CODEX_HOME`, and ChatGPT-managed login only. It rejects nonempty inherited config/managed requirements, unexpected environments, workspace roots, and instruction sources. All server requests except the current thread's registered dynamic tools are denied. [App-server protocol](https://learn.chatgpt.com/docs/app-server), [authentication](https://learn.chatgpt.com/docs/auth), [pinned thread protocol](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/app-server-protocol/src/protocol/v2/thread.rs), [pinned tool registration](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/core/src/tools/spec_plan.rs).
- Both bridges execute the existing validated, guarded, audited tools and approval broker in Electron main. Credential locations are protected from file tools; provider credentials, API keys, endpoint overrides and Node preload options are removed from runtime/shell environments as appropriate. The renderer receives status and chat events only. No runtime filesystem/shell tools are granted.
- Settings v1 migrates in memory to API mode; subsequent writes use v2. The existing `conversation.json` remains the API history. Subscriptions have separate conversation files. Each request starts an isolated runtime session and replays only that provider's app transcript; CLI session IDs/project histories are deliberately not resumed. This also prevents old runtime configuration from reappearing after a restart. The shared persisted message envelope retains tool-call/result pairing for all providers.
- **Claude distribution ambiguity remains unresolved:** the [Claude support article](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) describes using a Claude plan with the SDK, while the [SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) says third-party products offering claude.ai login require prior approval. Local implementation and tests do not establish such approval. Obtain clarification before distributing this as an authorized subscription integration; this PR makes no authorization claim.
- OpenAI's app-server documentation permits existing local/open-source integrations while distinguishing commercial/hosted services and recommending Sign in with ChatGPT for those use cases. This local implementation is not a claim of commercial/hosted authorization.

## Development

Choose an access provider and grant folders in **Settings**. API mode requires an Anthropic API key; subscription modes use bundled runtimes in the Windows x64 installer and require subscription sign-in, with no API key. Replies stream in, each tool call shows as a collapsible card, every write, move, delete and shell command waits for your approval, and **Stop** cancels a run. API mode shows setup guidance until a key is saved and a folder is granted; subscription mode shows runtime/sign-in guidance and does not require a key.

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

### CI

Every PR runs the Linux check. Windows CI runs on pushes to `main`, when a PR is marked ready for review, and on PRs labelled `windows-ci`. Add that label to PRs that touch Windows-specific code. See [docs/ci.md](docs/ci.md).

### Building the Windows installer

```sh
pnpm dist:win
```

The build downloads the complete official Codex Windows x64 release archive and checks its pinned SHA-256 from the official release asset. It checks the SDK's Claude executable against the pinned official Claude release manifest. Packaging fails on integrity errors. All Codex companions/resources and license files are preserved under `resources/runtimes`; Claude remains under `resources/app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64`. An after-pack check verifies all staged files against `src/main/providers/runtime-pins.json`, the digests the app also compiles in. Before starting a bundled runtime, the app streams a SHA-256 of the executable and every companion file (cached per file by size and modification time for the process lifetime) and refuses to run anything that is missing or differs, reporting repair guidance instead. Notices are in `resources/runtimes/notices`.

The app installer owns these runtime files: app upgrades replace them and uninstall removes them with the app. Credentials remain in userData, and independent CLI installations are untouched. Runtime subprocesses do not auto-update the bundled Claude binary. Development (unpackaged) builds resolve the matching native SDK/npm dependency or a compatible external runtime on PATH; packaged builds never do; architecture matching is explicit. Unsupported external versions are skipped, and failures report detected paths and versions. No global installations are modified.

This writes `release/<version>/Desktop-Agent-Setup-<version>-x64.exe`, an x64 NSIS installer that installs per user and lets you choose the install directory. CI builds the same installer on `windows-latest` and uploads it as the `desktop-agent-windows-x64` workflow artifact.

`pnpm dist:win` first builds `resources/helpers/job-run.exe` from `native/job-run` with MSVC (`pnpm build:helpers`; needs Visual Studio's C++ x64 build tools) and compiles its SHA-256 into the app; the after-pack check fails if the packaged helper does not match. See [docs/job-run.md](docs/job-run.md).

**The installer is not code-signed yet**, and neither is `job-run.exe`. Windows SmartScreen will warn about an unrecognised publisher when you run it, and antivirus may flag the unsigned helper; if it is quarantined, commands still run but without a Job Object, and the result says so. Signing is planned for the packaging milestone.

### Layout

```
src/main       Electron main process: window creation, security hardening, IPC handlers
src/main/chat         Chat session: runs the agent, streams events, brokers approvals
src/main/storage      Conversation and settings JSON in userData
src/main/agent        Agent loop and Claude API client (createAgent)
src/main/secrets      Encrypted API key store (safeStorage)
src/main/permissions  Granted folders, path guard, blocklist, audit log
src/main/tools        The agent's file and shell tools (createTools)
src/preload    contextBridge API exposed to the renderer as window.desktopApi
src/renderer   React UI (Vite): chat view, approval dialog, settings
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

| Tool                   | Does                                                                                    | Approval                    |
| ---------------------- | --------------------------------------------------------------------------------------- | --------------------------- |
| `list_granted_folders` | Current accessible grant roots, refreshed on each call; never adds permissions          | no                          |
| `list_dir`             | Entries with type, size, mtime; optional depth (max 5), at most 1000 entries            | no                          |
| `read_file`            | Text up to 1 MB (or a line range of a bigger file); refuses binary files                | no                          |
| `search_files`         | Name glob and/or content substring/regex; result, depth, entry and 10 s time caps       | no                          |
| `write_file`           | Create or replace a file; diffs over 256 KB are refused                                 | always, with the full diff  |
| `move_file`            | Move or rename within the grants                                                        | always                      |
| `delete_path`          | Send to the Recycle Bin (never a permanent delete)                                      | always                      |
| `run_shell`            | PowerShell (`-NoProfile -NonInteractive -EncodedCommand`) on Windows, `/bin/sh -c` else | always, exact command + cwd |

Tools never throw: a refused path, a declined approval, bad input or even a failing audit sink comes back as a normal result (`{ isError: true, content }` for failures), and a declined approval has no side effect.

`search_files` with only a name pattern lists matching names of any file, binary or not; content matches never come from binary files, files over 1 MB or hard-linked files. Glob and regex matching runs in a worker thread that is terminated at the search's time cap or when the call is cancelled, so a catastrophic pattern like `(a|aa)+$` cannot freeze the app.

**Granted folders.** The user grants folders (stored as real paths in `grants.json`); a drive root, a blocklisted folder or the app's own data cannot be granted. A path is allowed only when its real location is inside a granted folder: symlinks and junctions are resolved, and for a path that does not exist yet, the nearest existing parent is resolved. Windows comparisons ignore case. Rejected outright: relative paths, network (UNC) paths, `\\?\` and `\\.\` device paths, NTFS alternate data streams (`file:stream`), reserved device names (`CON`, `NUL`, `COM1`, `nul.txt`...), names ending in a dot or space (Windows strips them), and links whose target is missing (a write would create the target wherever it points). Windows 8.3 short names (`ENV~1.PRO` for `.env.production`) are expanded to the long name before any check, including for move and delete, which act on an entry without following it; a short alias of a link is refused. Regular files with more than one hard link are refused for reading, content search, writing, moving and deleting, since another name may live outside the grants; moving or deleting a folder is refused if any file anywhere inside it has more than one link (checked before and after approval), so a cross-volume move can never copy a hard-linked secret into a plain file. A grant whose folder is later replaced by a link stops working.

**Blocklist.** Always applied, even inside a granted folder, case-insensitively, to every segment of the path, and not configurable: `.ssh`, `.gnupg`, `.aws`, `.azure`, `.kube`, `.docker/config.json`, `.env` and `.env.*`, `*.pem`, `*.key`, `*.pfx`, `*.p12`, `*.kdbx`, `id_rsa*` / `id_dsa*` / `id_ecdsa*` / `id_ed25519*`, `.npmrc`, `.netrc` / `_netrc`, `.git-credentials`, Chrome / Edge / Brave / Chromium `User Data` and Firefox profiles, Windows Credential Manager, DPAPI (`Protect`), `Crypto` and `Vault` folders under `AppData`, and the app's own userData (grants, audit log, key store). Directory listings and searches hide blocked entries; moving or deleting a folder that contains one is refused.

**Audit log.** `audit.jsonl` gets one line per tool call: timestamp, tool, an argument summary, the resolved paths, approval (`auto`, `approved`, `denied`, `not-requested`), outcome, duration and, for failures, a short error category (`access-denied`, `declined`, `changed`, `hard-link`, `timeout`, `kill-failed`, a Node code like `EACCES`...), never the error message. It never contains file contents (writes log only the byte count). Search patterns are logged only as kind, length and flags. Shell commands are the exception, on purpose: the exact command and cwd of an approved run are the core of the audit trail, so they are logged in full, with token-like strings (`sk-...`, `ghp_...`, `password=...`) masked. A command the user declined (or that was never put to them) never ran, so only its length is logged. The log lives in userData, which the agent's tools can never read. If writing the log fails, the tool call still completes, `onAuditFailure` is called and `AuditLog.healthy` turns false; a throwing `onAuditFailure` or `onError` handler is contained and does not block later entries.

**Threat model.** The model is treated as untrusted: it may be steered by prompt injection in files it reads. The guard is what stops it reading secrets or touching anything outside the grants without asking; approvals are what stop it changing anything without the user seeing the change first. Known limits:

- `run_shell` is not sandboxed. Its cwd must be inside a grant, but the command itself can do anything the user can; the approval prompt showing the exact command is the only control. PowerShell and taskkill are started by absolute path under `%SystemRoot%` (and `/bin/sh` elsewhere), never looked up in the cwd or on `PATH`, and the approval shows that path. Right before spawning, the cwd is re-resolved through the guard and must still be granted and the same folder (device + inode) the user approved. The child gets the app's environment minus `ANTHROPIC_*` and `ELECTRON_*` variables.
- What is approved is bound to what was reviewed: `write_file` records the file's existence, inode, size, mtime and SHA-256 when it builds the diff and refuses the write if any of them changed by the time the user approves; new files are created exclusively (`O_EXCL`).
- Time-of-check/time-of-use, best effort within Node's limits: Node has no `openat()`-style handle-relative API, so a concurrent local process can still race a path between the check and the use. The tools narrow that window: files are opened (with `O_NOFOLLOW` on POSIX), the open handle is `fstat`ed and must be a single-link regular file with the same device and inode the guard checked, the path is re-guarded after opening, and every read and write goes through that handle. Directory walks re-check each folder just before listing it (still allowed by the guard, so a grant revoked mid-walk ends the walk; still a real folder with the same inode; real path unchanged), and stop at the first entry that is no longer inside a current grant. A local process that can win these races already runs as the user, so this protects against confusion rather than a determined local attacker. The model itself cannot create links or swap files except through an approved shell command.
- Killing a cancelled or timed-out command: on POSIX the shell's whole process group gets SIGKILL. On Windows, commands run inside a kill-on-close Job Object through the bundled, pinned `job-run.exe` (see [docs/job-run.md](docs/job-run.md)): cancel, timeout or the app dying kills every process the command started, including orphans, and background processes it leaves running are stopped (and counted in the result) when it finishes. Some processes escape by design (WMI/COM launches, services, scheduled tasks, hand-off to an already-running app). Without a verified `job-run.exe` (development builds, failed integrity check), the result says why and `taskkill /T /F` kills the tree; its exit code is checked, and if it fails (or the shell does not exit within 5 s) the result says the process tree may still be running instead of claiming it was killed. A process that detaches from the tree (for example a grandchild whose parent already exited) can escape `taskkill /T`.
- Matching a regex is bounded by the search time cap but still costs CPU in a worker thread until it is terminated.

Follow-ups (not done yet): run commands with an allowlisted environment instead of the app's environment minus a denylist; sign `job-run.exe` with the installer.

### Agent loop and API key storage

`createClaudeClient(apiKey)` uses the official Anthropic SDK with two retries and a two-minute request timeout. `createAgent({ client, tools, model?, systemPrompt?, maxTurns?, maxTokens? })` defaults to 10 API turns, 4096 output tokens and `claude-sonnet-5-5`, the current Sonnet model verified against the [model documentation](https://platform.claude.com/docs/en/models/overview) and SDK 0.133.0. Model selection remains configurable.

Call `agent.run(conversation, { signal, requestApproval, onEvent })`. It returns `{ conversation, stopReason }`; history is a copied array of Anthropic `MessageParam` objects, suitable for JSON persistence. The caller owns persistence and must avoid overlapping runs on the same conversation. The system prompt restricts access to granted folders, requires approval for mutations/shell, and treats file contents as untrusted data. Actual permissions and input validation remain the tools' responsibility.

Typed events include `text_delta`, `tool_use` (complete input, immediately before execution), `tool_result`, `approval_requested`, `approval_resolved`, `usage`, `turn_complete`, `response_discarded` (the turn's response was dropped, so a UI must remove that turn's streamed text), and `error`. Tool and approval events carry the tool-use ID and turn number; usage includes the SDK's cache/token accounting. Event callbacks should be synchronous; callback exceptions are swallowed so observers cannot interrupt tool/result pairing. Parallel calls execute concurrently and their results are submitted together in original order. Unknown tools and execution failures become `is_error` results. Approval decisions pass through the tool context; a tool must honor denial before causing side effects.

Cancellation aborts the SDK stream and passes the same signal to tools. Pending tools and approval waits release the run promptly; tools must cooperate with the signal to stop underlying I/O or child processes. Aborted tool batches retain paired error results; incomplete streamed messages are not persisted. A truncated response containing tool calls is discarded without executing those calls. `pause_turn` continues the assistant response within the turn budget; `end_turn` and `stop_sequence` finish normally. Truncation, refusal, context exhaustion and turn exhaustion return explicit errors without automatic continuation. These behaviors follow Anthropic's [stop-reason guidance](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons). API errors expose sanitized messages, never raw SDK errors. Error codes:

| Code              | Meaning                                                               |
| ----------------- | --------------------------------------------------------------------- |
| `authentication`  | The API key was rejected (401)                                        |
| `permission`      | The key lacks access, for example to the model (403)                  |
| `invalid_request` | The request was rejected (400, 404, 413): model, format or size       |
| `rate_limit`      | Rate limited (429, or a streamed `rate_limit_error`)                  |
| `overloaded`      | The API is overloaded (529, or a streamed `overloaded_error`)         |
| `network`         | Could not connect                                                     |
| `api`             | Any other API failure                                                 |
| `aborted`         | The run was cancelled                                                 |
| `max_turns`       | The run reached its turn limit                                        |
| `max_tokens`      | A response hit the output token limit                                 |
| `refusal`         | Claude declined the request                                           |
| `context_limit`   | The conversation exceeds the model's context window                   |
| `protocol`        | An unexpected response (unknown stop reason, tool use without calls…) |

The chat session adds its own codes for the UI: `no_api_key`, `key_unreadable`, `busy` (a run, New chat, provider switch or the initial load is in progress) and `internal`. It also reuses `invalid_request` for an empty message, `aborted` for a run stopped before its reply started, and `authentication` when the selected subscription is unavailable. The SDK handles transient retries; the loop never retries tool side effects. Two ephemeral cache breakpoints are set: on the system text (which also covers the tool definitions before it) and on the last block of the last message, added to the request's copy only so persisted history never carries `cache_control`. Cache hits depend on Anthropic's minimum prompt size. Empty text blocks are dropped before an assistant message is saved, and a message with nothing else is not saved at all.

After Electron is ready, construct `createApiKeyStore({ userDataPath: app.getPath('userData'), safeStorage, fs? })` using Electron's `safeStorage`; the optional filesystem dependency is injectable. Its async `get`, `set`, `clear` and `hasKey` methods store only encrypted bytes in `anthropic-api-key.enc`, using temporary-file replacement and serialized operations. Windows uses Electron's DPAPI-backed encryption. Unavailable encryption and Linux's `basic_text` fallback are rejected. Missing keys return `null`; corrupted or undecryptable files raise a clear error and can be cleared. Keys and raw API errors are never logged by these modules.

Tests use a fake streaming client and fake encryption without network or Electron. Storage tests use isolated temporary directories and native path operations for Windows/Linux portability.

### Chat window, IPC and approvals

`src/main/services.ts` builds everything from userData at startup: the key store, `GrantStore`, `PathGuard`, `AuditLog`, `createTools` (with `shell.trashItem`), the settings store and the chat session. API mode builds `createAgent` + `createClaudeClient` for each run with the current key and model. Subscription mode selects the corresponding main-process adapter without reading the key store. Provider switches stop the current run and serialize history/settings changes. Loading the saved conversation at startup goes through the same queue, so sends wait for it and a slow load can never overwrite a later switch.

**IPC.** The contract is `src/shared/ipc.ts`; the preload exposes it as `window.desktopApi`. Every renderer → main handler (`src/main/ipc-handlers.ts`) first checks that the call comes from the app window's current main frame (the same `WebFrameMain` object as `webContents.mainFrame`), that it is top-level and on an app URL, and throws otherwise.

| Area      | Calls                                               | Notes                                                                    |
| --------- | --------------------------------------------------- | ------------------------------------------------------------------------ |
| API key   | `apiKey.status`, `set`, `clear`                     | Returns `{ saved, error }` only; the key never goes back to the renderer |
| Grants    | `grants.list`, `add`, `remove`                      | `add` takes no argument: main opens the native folder picker             |
| Model     | `model.get`, `set`                                  | `settings.json` in userData; only offered models; default from the agent |
| Chat      | `chat.load`, `send`, `stop`, `newChat`              | One run at a time; `send` returns once the run has started               |
| Approvals | `approvals.respond(id, approved)`                   | Only a pending id resolves anything; only `true` approves                |
| Audit     | `audit.status`                                      | `{ healthy, path }`                                                      |
| Pushes    | `onChatEvent`, `onApprovalRequest`, `onAuditStatus` | Main → renderer; each returns an unsubscribe function                    |

**Approval flow.** When a tool asks for approval, the session gives the request a random id (`crypto.randomUUID`) and pushes it to the window with the tool, kind, summary and full detail: the whole diff for `write_file`, and the exact shell path, working folder and command for `run_shell`. The tool waits until the renderer answers that id. Answers from another frame, for an unknown or already settled id, or with anything but `approved === true` never approve anything. Every pending approval is denied when the user presses Stop, starts a new chat, reloads or closes the window, the renderer crashes, the app quits, or the run ends. The dialog focuses **Deny**, Escape denies, Tab stays inside the dialog, and further requests queue behind it.

Every untrusted field in the dialog (tool name, summary, paths, shell path, cwd, command and each diff line) goes through `revealUnsafe` (`src/renderer/src/components/reveal.tsx`), a display-only transform. Bidi controls (U+202A–202E, U+2066–2069, U+200E/200F, U+061C), zero-width characters (U+200B–200D, U+2060, U+FEFF), C0/C1 controls other than tab and LF, U+2028/2029, and whole ANSI escape sequences are shown as highlighted tokens such as `⟨U+202E⟩` or `⟨ESC[31m⟩`, and the dialog shows a warning when any are present. CRLF line ends are marked `⟨CRLF⟩`; a bare CR (a line break for PowerShell) is marked `⟨CR⟩`, starts a new line and also triggers the warning. Each line is isolated left-to-right (`dir="ltr"`, `unicode-bidi: isolate`). Commands wrap; diffs scroll horizontally; nothing is truncated. What runs is never changed.

**Conversation.** The current conversation (Messages-API history) is saved as `conversation.json` in userData after the user's message and after each run. **New chat** is reserved immediately: sends are refused until it finishes, repeated New chat calls run one after another, any run is stopped first, and the reset reaches the UI only after the file is deleted. A run from before the reset can never save its history. If saving or deleting fails, the chat shows a storage warning. On load, every message and block is validated (roles, block types and field types, and every tool call answered exactly by the next message's results); anything malformed starts a fresh conversation with a notice. An error boundary around the chat view offers a new chat if rendering still fails. If writing the audit log fails, a warning banner says so (from `onAuditFailure` and `AuditLog.healthy`); Settings shows the log's location.

**Rendering.** Assistant text is rendered as Markdown with `react-markdown` without raw HTML (`skipHtml`), images are shown only as `[image: alt]` and never loaded, unsafe URLs are stripped by react-markdown's default URL transform, and links open in the default browser through the window-open handler. Nothing uses `dangerouslySetInnerHTML`; model output and file contents are treated as untrusted. When the agent discards a truncated response, the UI removes that turn's streamed text. A reply cut off by Stop stays on screen, marked as not saved.

Renderer tests run in jsdom with Testing Library (`src/renderer/**/*.test.tsx`, the `renderer` Vitest project); main-process tests run in Node (the `main` project).

### Workspace chat

**Composer and shortcuts.** Provider and model pickers live in the composer. Switching provider uses the same operation as Settings (the conversation is cleared, with separate history per provider). The model picker uses `provider.models()` / `provider.setModel()` for Codex and the existing model API for Anthropic API mode; it is hidden when a provider has no model list (Claude subscription). A usage indicator next to the pickers reads `provider.allowance()` (on provider switch, after each completed turn and on usage-limit errors; never polled) and is advisory only: amber from 80% of any window used, red when limited, and it never blocks sending. Click it to open account settings.

| Shortcut            | Action                                                                 |
| ------------------- | ---------------------------------------------------------------------- |
| Enter / Shift+Enter | Send / new line in the message box                                     |
| Esc                 | Stop a running reply (in an approval dialog, Esc still denies instead) |
| Ctrl+N (Cmd+N)      | New chat                                                               |
| Ctrl+, (Cmd+,)      | Open Settings                                                          |
| Ctrl+K (Cmd+K)      | Focus the message box                                                  |

Assistant Markdown supports GFM tables, task lists and strikethrough, and highlights code (TypeScript, JavaScript, JSON, Bash, PowerShell, Python, CSS, HTML, Markdown, diff, YAML) with a Copy button that copies the raw source text. Raw HTML is still dropped, images are never loaded and unsafe links are stripped. Consecutive tool calls in a turn are grouped into one collapsible "Used N tools" block.

The sidebar shows the selected provider and granted folders. Provider selection uses the same switch operation as Settings, with separate history for each provider; there is no automatic fallback. Progress and assistant labels identify the selected provider. A signed-in status confirms authentication, not remaining subscription quota.

The native Codex tool regression test uses a local fake Responses server with the real pinned app-server and execution host. It discovers granted folders, lists an RFI subfolder, confirms a denied shell command does not run, and refuses a read outside the grant. No subscription or API key is used. This runs on Windows CI and against the installer’s bundled runtimes. Real-window tests cover the workspace layout at 360px and 1280px.
