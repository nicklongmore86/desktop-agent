# Connections

A **connection** is one way the app reaches a model: a **vendor** (who serves it) plus
an **access type** (how the user pays). It replaced the closed list of three providers,
which mixed the two ("claude-subscription" is Anthropic _and_ a subscription).

| Connection id         | Vendor      | Access         | Signs in with                  |
| --------------------- | ----------- | -------------- | ------------------------------ |
| `claude-subscription` | `anthropic` | `subscription` | Claude Code's own login        |
| `codex-subscription`  | `openai`    | `subscription` | Codex's own login (ChatGPT)    |
| `anthropic-api`       | `anthropic` | `api-key`      | The user's saved Anthropic key |

Vendors are `anthropic | openai | google | local | openrouter`; access types are
`free | subscription | api-key` (`src/shared/ipc-connections.ts`). Add a vendor there
before registering its first adapter.

**Ids never change.** A connection id names its history directory
(`userData/history/<id>/`) and its key file (`userData/secrets/<id>.enc`), so the three
built-in ids are the old provider ids and nothing moved on disk. An id is lowercase
letters, digits and hyphens (`CONNECTION_ID`), so it is always one safe path segment,
and main only uses one after looking it up in the registry.

## The registry

`ConnectionService` (`src/main/providers/service.ts`) holds a `ConnectionRegistry` of
adapters and is the only thing the rest of main calls. It keeps what spans connections:
one sign-in at a time (a second is refused), Cancel (which also aborts status checks),
dropping cached metadata on a switch, and the default answers for operations an adapter
leaves out. An unknown id is refused with "Unknown provider." before any adapter runs.

```ts
interface ConnectionAdapter {
  // Descriptor: sent to the renderer by connections.list(); nothing here is secret.
  id: ConnectionId
  vendor: Vendor
  access: AccessType
  label: string // composer picker and header: "Claude · Subscription"
  shortLabel: string // chat list badge: "Claude"
  title: string // Settings card
  description: string
  runtimeLabel?: string // "Can't start Claude Code"
  capabilities: {
    authKind: 'runtime-login' | 'api-key' | 'local' | 'none'
    listsModels: boolean
    reportsUsage: boolean
    needsRuntime: boolean
  }
  personalUseOnly: boolean
  pickerOrder: number // the composer picker's order (Settings uses registration order)

  status(signal?): Promise<ProviderStatus> // never throws
  runner(tools, signal?): Promise<AgentRunner> // throws; failure() maps it
  failure(error: unknown): ProviderFailure // safe code + message, never provider text
  models?(): Promise<ProviderModels>
  setModel?(model: string | null): Promise<ProviderModels>
  allowance?(): Promise<ProviderAllowance>
  login?(session: LoginSession): Promise<void>
  invalidate?(): void
}
type AdapterFactory = (host: AdapterHost) => ConnectionAdapter
```

`AdapterHost` (the service) gives an adapter the settings store, the per-connection key
store, `openUrl`, `context(runtime)` for a bundled runtime's isolated directory, and
`track(signal)` for a status check Cancel can abort.

## Adding a connection

A connection that talks to a model API directly uses the **AgentClient slot**: describe
it and supply an `AgentClient` (`src/main/agent/types.ts`). `agentClientAdapter` builds
the adapter, and `createAgent` runs the same tool loop, approvals and audit log as every
other connection. Anthropic API is built this way (`adapters/anthropic-api.ts`).

```ts
// src/main/providers/adapters/openai-api.ts
export const createOpenAIApiAdapter = agentClientAdapter({
  id: 'openai-api',
  vendor: 'openai',
  access: 'api-key',
  label: 'GPT · API',
  shortLabel: 'GPT API',
  title: 'OpenAI API',
  description: 'Use your own API key.',
  capabilities: {
    authKind: 'api-key',
    listsModels: false,
    reportsUsage: false,
    needsRuntime: false,
  },
  personalUseOnly: false,
  pickerOrder: 3,
  client: ({ key }) => createOpenAICompatClient({ apiKey: key ?? '', baseUrl: '…' }),
  model: (host) => host.settings?.selection('openai-api') ?? 'gpt-…',
  readyMessage: 'OpenAI API mode uses your saved API key and separate API billing.',
  missingKeyMessage: 'Add your OpenAI API key in Settings.',
  wording: { planNotEntitled: '…', usageLimit: '…' },
})
```

Then register it, either with the built-ins (`BUILTIN_ADAPTERS` in `service.ts`, whose
order is the Settings order) or at runtime with `connections.registerAdapter(factory)`.
For `authKind: 'api-key'` the runner reads the key from `userData/secrets/<id>.enc` and
refuses to start without one (`no_api_key`); for `local` or `none` the client gets
`key: null`. Also add the connection to the test fixture
(`src/shared/connections-fixture.ts`) and the e2e fake (`e2e/harness/preload.cjs`);
`registry.test.ts` fails until the fixture matches the real list.

A connection that needs its own runtime or sign-in implements `ConnectionAdapter`
directly, as `adapters/claude-subscription.ts` and `adapters/codex-subscription.ts` do.

## What each adapter keeps

The subscription adapters keep the safety rules they had before; the split moved code,
not rules:

- **Both:** the runtime starts from `isolatedContext` (`isolation.ts`): its own directory
  under `userData/providers/`, refused if any user configuration appears there, the
  allowlisted environment (`runtimeEnv`, no API keys or endpoints), and discovery's
  pinned-version and digest checks. No fallback to API billing: neither reads a key.
- **Claude subscription:** no tools of its own, no setting sources, Claude.ai login only
  (API-key, token and Free accounts refused), init tools checked (`claude.ts`). Only a
  structured, rejected rate limit with a plausible reset blocks Send.
- **Codex subscription:** ChatGPT login forced, config layers and API keys refused
  (`codex.ts`); auth, entitlement and usage are checked inside the run.

Errors go through each adapter's `failure()`, which uses `mapFailure(error, wording)`
(`errors.ts`): it extracts known codes and reset times only, and the message is always
written in the app. Only the plan and limit messages differ per connection.

## Settings and keys

`settings.json` version 3 has `connection` (was `provider`), `connectionModels` (was
`providerModels`; same ids), `connections` (the configured connections, `{ id }[]`) and
`showPersonalUseConnections`. v1 and v2 files are read and migrated in memory; the first
write saves version 3. Theme, model and layout are unchanged. A saved connection the
build does not offer falls back to `anthropic-api` when the app starts.

Keys are per connection in `userData/secrets/<id>.enc`, encrypted with `safeStorage`
(the `basic_text` backend is refused). The old `anthropic-api-key.enc` is moved there,
as encrypted bytes, on first use; clearing removes both files so a cleared key cannot
come back. The renderer only ever learns whether a key is saved.

## Personal-use connections

**Claude subscription is marked `personalUseOnly`.** It signs in with the user's own
Claude.ai account through Claude Code. Anthropic's terms require approval before a
third-party product offers Claude.ai login, so a build shared with other people must be
able to leave it out. `showPersonalUseConnections` (in settings, default `true`) decides:
when it is `false`, `connections.list()` leaves the connection out, main refuses to
switch to it, and a saved choice of it falls back to the default. The default keeps the
app as it was for its current user; there is no Settings toggle yet.
