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

### Agent loop and API key storage

The main-process modules in `src/main/agent` and `src/main/secrets` are ready for integration; IPC/UI wiring is a later task. `createClaudeClient(apiKey)` uses the official Anthropic SDK with two retries and a two-minute request timeout. `createAgent({ client, tools, model?, systemPrompt?, maxTurns?, maxTokens? })` defaults to 10 API turns, 4096 output tokens and `claude-sonnet-5-5`, the current Sonnet model verified against the [model documentation](https://platform.claude.com/docs/en/models/overview) and SDK 0.133.0. Model selection remains configurable.

Call `agent.run(conversation, { signal, requestApproval, onEvent })`. It returns `{ conversation, stopReason }`; history is a copied array of Anthropic `MessageParam` objects, suitable for JSON persistence. The caller owns persistence and must avoid overlapping runs on the same conversation. The system prompt restricts access to granted folders, requires approval for mutations/shell, and treats file contents as untrusted data. Actual permissions and input validation remain the tools' responsibility.

Typed events include `text_delta`, `tool_use` (complete input, immediately before execution), `tool_result`, `approval_requested`, `approval_resolved`, `usage`, `turn_complete`, and `error`. Tool and approval events carry the tool-use ID and turn number; usage includes the SDK's cache/token accounting. Event callbacks should be synchronous; callback exceptions are swallowed so observers cannot interrupt tool/result pairing. Parallel calls execute concurrently and their results are submitted together in original order. Unknown tools and execution failures become `is_error` results. Approval decisions pass through the tool context; a tool must honor denial before causing side effects.

Cancellation aborts the SDK stream and passes the same signal to tools. Pending tools and approval waits release the run promptly; tools must cooperate with the signal to stop underlying I/O or child processes. Aborted tool batches retain paired error results; incomplete streamed messages are not persisted. A truncated response containing tool calls is discarded without executing those calls. `pause_turn` continues the assistant response within the turn budget; `end_turn` and `stop_sequence` finish normally. Truncation, refusal, context exhaustion and turn exhaustion return explicit errors without automatic continuation. These behaviors follow Anthropic's [stop-reason guidance](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons). API errors expose sanitized authentication, rate-limit, overload, connection or generic messages. The SDK handles transient retries; the loop never retries tool side effects. System text and the last tool definition have ephemeral cache breakpoints (cache hits depend on Anthropic's minimum prompt size).

After Electron is ready, construct `createApiKeyStore({ userDataPath: app.getPath('userData'), safeStorage, fs? })` using Electron's `safeStorage`; the optional filesystem dependency is injectable. Its async `get`, `set`, `clear` and `hasKey` methods store only encrypted bytes in `anthropic-api-key.enc`, using temporary-file replacement and serialized operations. Windows uses Electron's DPAPI-backed encryption. Unavailable encryption and Linux's `basic_text` fallback are rejected. Missing keys return `null`; corrupted or undecryptable files raise a clear error and can be cleared. Keys and raw API errors are never logged by these modules.

Tests use a fake streaming client and fake encryption without network or Electron. Storage tests use isolated temporary directories and native path operations for Windows/Linux portability.
