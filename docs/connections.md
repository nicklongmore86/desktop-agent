# Connections

A **connection** is one way the app reaches a model: a **vendor** (who serves it) plus
an **access type** (how the user pays). It replaced the closed list of three providers,
which mixed the two ("claude-subscription" is Anthropic _and_ a subscription).

| Connection id         | Vendor       | Access         | Signs in with                   |
| --------------------- | ------------ | -------------- | ------------------------------- |
| `claude-subscription` | `anthropic`  | `subscription` | Claude Code's own login         |
| `codex-subscription`  | `openai`     | `subscription` | Codex's own login (ChatGPT)     |
| `chatgpt-plan`        | `openai`     | `plan`         | Sign in with ChatGPT (main)     |
| `anthropic-api`       | `anthropic`  | `api-key`      | The user's saved Anthropic key  |
| `openai-api`          | `openai`     | `api-key`      | The user's saved OpenAI key     |
| `gemini-api`          | `google`     | `api-key`      | A Gemini (AI Studio) key        |
| `openrouter-api`      | `openrouter` | `api-key`      | The user's saved OpenRouter key |
| `ollama`              | `local`      | `free`         | Nothing: a server on loopback   |
| `lmstudio`            | `local`      | `free`         | Nothing: a server on loopback   |

Vendors are `anthropic | openai | google | local | openrouter`; access types are
`free | subscription | plan | api-key` (`src/shared/ipc-connections.ts`). Add a vendor there
before registering its first adapter.

**Ids never change.** A connection id names its history directory
(`userData/history/<id>/`) and its key file (`userData/secrets/<id>.enc`), so the first
three ids are the old provider ids and nothing moved on disk. An id is lowercase
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
    authKind: 'runtime-login' | 'chatgpt-login' | 'api-key' | 'local' | 'none'
    listsModels: boolean
    reportsUsage: boolean
    needsRuntime: boolean
  }
  personalUseOnly: boolean
  pickerOrder: number // the composer picker's order (Settings uses registration order)
  notice?: string // shown before use: Gemini's free-tier data use
  defaultBaseUrl?: string // local servers: their base URL can be changed (loopback only)

  status(signal?): Promise<ProviderStatus> // never throws
  runner(tools, signal?): Promise<AgentRunner> // throws; failure() maps it
  failure(error: unknown): ProviderFailure // safe code + message, never provider text
  models?(): Promise<ProviderModels>
  setModel?(model: string | null): Promise<ProviderModels>
  allowance?(): Promise<ProviderAllowance>
  login?(session: LoginSession): Promise<void>
  invalidate?(): void
  forget?(): Promise<string | null> // on remove: sign out and delete stored tokens
  validateKey?(key, signal?): Promise<ProviderFailure | null> // read-only, before a key is saved
  baseUrl?(): { baseUrl: string; custom: boolean }
  setBaseUrl?(baseUrl: string | null): Promise<{ baseUrl: string; custom: boolean }>
}
type AdapterFactory = (host: AdapterHost) => ConnectionAdapter
```

`AdapterHost` (the service) gives an adapter the settings store, the per-connection key
store, `openUrl`, `context(runtime)` for a bundled runtime's isolated directory, and
`track(signal)` for a status check Cancel can abort.

## Adding a connection

A connection that talks to a model API directly uses the **AgentClient slot**: describe
it and supply an `AgentClient` (`src/main/agent/types.ts`). `agentClientAdapter`
(`adapters/agent-client.ts`) builds the adapter, and `createAgent` runs the same tool
loop, approvals and audit log as every other connection. Anthropic API is built this way
(`adapters/anthropic-api.ts`).

A connection that can also list its models and check a key builds on that with
`modelApiAdapter` (`adapters/model-api.ts`). It adds `status()`, `models()`,
`setModel()`, `validateKey()` and, for local servers, the base URL setting. The five
newer connections use it; `adapters/compat.ts` supplies the Chat Completions parts
(`createOpenAICompatClient`, `listOpenAICompatModels`, `validateOpenAICompatKey`):

```ts
// src/main/providers/adapters/openai-api.ts
export const openAIApiAdapter = (options: AdapterTestOptions = {}) =>
  modelApiAdapter({
    id: OPENAI_API,
    vendor: 'openai',
    access: 'api-key',
    label: 'OpenAI · API',
    shortLabel: 'OpenAI', // also the name in the agent loop's own messages
    title: 'OpenAI API',
    description: 'Use your own OpenAI API key. Billed by OpenAI.',
    capabilities: {
      authKind: 'api-key',
      listsModels: true,
      reportsUsage: false,
      needsRuntime: false,
    },
    personalUseOnly: false,
    pickerOrder: 3,
    ...compatSpec('openai', options), // client, list, checkKey, errorEvent
    recommended: ['gpt-5.5', 'gpt-5.1', 'gpt-5', 'gpt-5-mini', 'gpt-4.1', 'gpt-4o'],
    readyMessage: () => 'OpenAI API mode uses your saved API key and separate API billing.',
    missingKeyMessage: 'Add your OpenAI API key in Settings.',
    noModelsMessage: 'This OpenAI key has no chat models available.',
  })
export const createOpenAIApiAdapter = openAIApiAdapter()
```

`options.fetch` exists for tests only: they serve the pinned host from a local fake
server (`adapters/new-connections.test.ts`). No test uses a real account or the network.

What `modelApiAdapter` does for every such connection:

- **Status.** API keys: no key is `signed-out` with `missingKeyMessage`; a saved key is
  checked with `checkKey` (cached for a minute per key) and is `ready` or `error` with the
  client's own message. Local servers: `GET /v1/models` with a 3-second timeout; `ready`
  with the model count, or `error` with `unreachableMessage` ("Ollama isn't running.
  Install it from ollama.com, start it, then check again.") and code
  `runtime_unavailable`, or `noModelsMessage` when the list is empty.
- **Models.** `list()` filters to models that can run the tool loop (OpenAI drops
  embeddings, audio and image models; OpenRouter keeps only models that advertise
  `tools`; Gemini keeps `generateContent` chat models). The default is the first
  `recommended` id that is listed, else the first one. Local lists mark `toolSupport:
'unknown'` and carry `modelWarning`, which Settings shows. `setModel` saves the choice
  per connection (`connectionModels`); a Send without one uses the default.
- **Keys.** `validateKey` runs before `apiKey.set` stores anything: `GET /models` (OpenAI),
  `models.list` (Gemini) or `GET /api/v1/key` (OpenRouter, whose model list is public).
  Never a completion. A refused key is not saved and `apiKey.set` answers with the
  client's message and the key that is still stored, if any.
- **Hosts.** Hosted flavors always use their one pinned https host (`resolveBaseUrl`
  refuses any other, and redirects are never followed); Gemini's host is fixed in its
  client. Local servers never get a key.
- **Errors.** Everything goes through the client's own `errorEvent`
  (`openAICompatErrorEvent`, `geminiErrorEvent`), in the agent loop and in `failure()`.

`errorEvent` maps whatever the client throws to a safe code and app-written message, both
inside the agent loop (`createAgent`'s `errorEvent` option, which defaults to Anthropic's
`apiErrorEvent`) and in the adapter's `failure()`. The loop's own messages ("… reached the
output token limit") name `createAgent`'s `modelName`, which `agentClientAdapter` sets to
the connection's `shortLabel` (Anthropic API passes `modelName: 'Claude'`, the default).

Then register it, either with the built-ins (`BUILTIN_ADAPTERS` in `service.ts`, whose
order is the Settings order) or at runtime with `connections.registerAdapter(factory)`.
For `authKind: 'api-key'` the runner reads the key from `userData/secrets/<id>.enc` and
refuses to start without one (`no_api_key`); for `local` or `none` the client gets
`key: null`. Also add the connection to the test fixture
(`src/shared/connections-fixture.ts`) and the e2e fake (`e2e/harness/preload.cjs`);
`registry.test.ts` fails until the fixture matches the real list.

A connection that needs its own runtime or sign-in implements `ConnectionAdapter`
directly, as `adapters/claude-subscription.ts`, `adapters/codex-subscription.ts` and
`adapters/chatgpt-plan.ts` do. ChatGPT Plan is described in [chatgpt-plan.md](chatgpt-plan.md).

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

Errors go through each adapter's `failure()`. The subscriptions use
`mapFailure(error, wording)` (`errors.ts`): it extracts known codes and reset times only,
and the message is always written in the app; only the plan and limit messages differ
between them. API connections use their client's `errorEvent` (above).

## Settings and keys

`settings.json` version 3 has `connection` (was `provider`), `connectionModels` (was
`providerModels`; same ids), `connections` (the configured connections,
`{ id, baseUrl?, vision? }[]`) and `showPersonalUseConnections`. `vision` is "This
model can see images" (absent means off), used only where the model list does not say
(`docs/provider-images.md`); an older app version ignores it and drops it on its next
write. `baseUrl` is a local server's
API root when it is not the default; main saves it only after `resolveBaseUrl` accepts it
(`http://` on `127.0.0.1`, `::1` or `localhost`, no credentials, query or fragment) and
checks it again before every request, so a hand-edited file cannot point it elsewhere.
Adding a connection to the registry, saving its key or changing its base URL never
changes `connection`: nobody is switched. v1 and v2 files are read and migrated in memory; the first
write saves version 3. Theme, model and layout are unchanged. A saved connection the
build does not offer falls back to `anthropic-api` when the app starts.

`turnLimit` (added without a version bump) is how many steps one message may take in the
app's own agent loop before it pauses: Settings › Agent › Steps per message, a whole number
from 5 to 100 (`TURN_LIMIT` in `src/shared/ipc.ts`), checked in main before it is saved. A
missing or invalid value, as in every file saved before it existed, means the
default of 35. The API connections and ChatGPT · Plan read it each time a runner is built; Claude
subscription keeps its runtime's 40 turns and Codex its own limit.

Keys are per connection in `userData/secrets/<id>.enc`, encrypted with `safeStorage`
(the `basic_text` backend is refused). The old `anthropic-api-key.enc` is moved there,
as encrypted bytes, on first use; clearing removes both files so a cleared key cannot
come back. The renderer only ever learns whether a key is saved. Model ids
(`MODEL_ID` in `settings-store.ts`) allow `/`, `:` and `@` for OpenRouter, Ollama and LM
Studio ids, but nothing shaped like a path.

## Adding and choosing connections (the wizard)

The renderer builds **Add connection** (the first-run wizard, the composer picker's last
item "Add or manage connections…", and Settings → Accounts & providers → Add connection)
from `connections.list()` and one small static table, `src/shared/access-matrix.ts`. The
table maps a provider card (Claude, ChatGPT, Gemini, Local models, OpenRouter) and an
access type (Free, Subscription, API key) to connection ids, or to a reason it cannot work
and the next step (Claude Free; Gemini Free and Subscription). A segment that does not
apply is left out; a connection main does not list is shown unavailable; a personal-use
connection main hides is left out. **A new connection appears in the wizard by being
registered**, as long as its id is named in that table.

The flow is a reducer (`components/connections/flow.ts`): provider → access → connect →
model → folder → done. Connecting uses the existing IPC only: `provider.set` makes the
connection current, then `provider.login` / `cancelLogin` and the sign-in panel, or
`apiKey.set(key, id)`, or `provider.get` for "Check again" on a local server. Cancelling
before the connection is made puts back the connection chats went to, and takes the new
one out of the set-up list again.

Small calls beside `connections.list()` make this possible (`ipc-connections.ts`):

| Call                                           | Does                                                                                                 |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `connections.state()`                          | The set-up connection ids, the current one, and `showPersonalUse`.                                   |
| `connections.status(id)`                       | Any listed connection's status, without switching to it.                                             |
| `connections.add(id)` / `remove(id)`           | Edit settings `connections`. `remove` refuses the current connection.                                |
| `connections.setShowPersonalUse(show)`         | Sets `showPersonalUseConnections`; refuses to hide the current connection.                           |
| `connections.vision(id)` / `setVision(id, on)` | Whether images reach the current model, and "This model can see images" (`docs/provider-images.md`). |

Every id is checked against the registry first (`parseConnectionId`), and removing a
connection never touches chat history. Removing a connection with `forget()` (ChatGPT
Plan) signs it out first; if its stored sign-in cannot be deleted it stays listed, and an
unconfirmed revocation comes back as `notice` on the state `remove` returns. The renderer deletes an API-key connection's saved
key only after the user confirms. The composer lists the connections that are ready (a
saved key for API-key ones, otherwise a ready status) plus the one in use.

Everything the renderer shows from these (labels, model names, status messages) is
rendered as text, never HTML.

## Personal-use connections

**Claude subscription is marked `personalUseOnly`.** It signs in with the user's own
Claude.ai account through Claude Code. Anthropic's terms require approval before a
third-party product offers Claude.ai login, so a build shared with other people must be
able to leave it out. `showPersonalUseConnections` (in settings, default `true`) decides:
when it is `false`, `connections.list()` leaves the connection out, main refuses to
switch to it, and a saved choice of it falls back to the default. The default keeps the
app as it was for its current user. Settings → Accounts & providers has the
"Show personal-use connections" toggle.
