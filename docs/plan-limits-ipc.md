# Subscription models, allowance and errors

Wave 2 should consume the types in `src/shared/ipc.ts` through
`window.desktopApi.provider`. These calls concern the currently selected provider;
ignore a successful response if the user switches provider while awaiting it (each
value includes `provider`). They make metadata/auth requests only; they never start a
model turn. There is no allowance polling loop. Refresh on opening Settings or on
an explicit user action. Errors from a run arrive on the existing chat event push.

## IPC contract

| Preload method                             | IPC channel          | Result                                   |
| ------------------------------------------ | -------------------- | ---------------------------------------- |
| `provider.models()`                        | `provider:models`    | `ProviderResult<ProviderModels>`         |
| `provider.setModel(model: string \| null)` | `provider:set-model` | `ProviderResult<ProviderModels>`         |
| `provider.allowance()`                     | `provider:allowance` | `ProviderResult<ProviderAllowance>`      |
| `provider.get()`                           | `provider:get`       | `ProviderStatus` (additive fields below) |

```ts
type ProviderResult<T> = { ok: true; value: T } | { ok: false; failure: ProviderFailure }

interface ProviderModels {
  provider: ProviderId
  options: ProviderModel[]
  selectedModel: string | null // effective, validated against current catalog
  savedModel: string | null // persisted preference, even if currently unavailable
  defaultModel: string | null
  resolvedModel: string | null // last thread/start resolution this app session
}
interface ProviderModel {
  id: string // model slug to pass to setModel, not catalog record id
  label: string
  defaultReasoningEffort: string | null
  supportedReasoningEfforts: string[]
  isDefault: boolean
}
interface ProviderAllowance {
  provider: ProviderId
  plan: string | null
  credits?: { hasCredits: boolean; unlimited: boolean } // availability flags only
  state: 'available' | 'limited' | 'unknown'
  resetsAt: string | null // advisory reset when limited; never proof of recovery
  windows: {
    limitId: string // quota bucket plus :primary or :secondary
    remainingPercent: number // 0..100; NOT a number of requests or tokens
    resetsAt: string | null // ISO 8601 UTC
    label?: string // "weekly limit", "5-hour limit"; from the window length, absent if unknown
  }[]
  lastError: ProviderFailure | null // historical, not proof of current blockage
}
interface ProviderFailure {
  code: ChatErrorCode
  message: string // app-authored safe explanation
  resetsAt?: string // ISO 8601 UTC, only if supplied by runtime
}
```

Metadata calls always return a serializable `ProviderResult` for operational and
validation failures, so Electron never has to serialize an Error's custom fields.
Use `result.value` only when `result.ok`; otherwise render `result.failure.code`,
`message` and optional `resetsAt`. Untrusted IPC senders are still rejected by the
existing security boundary, rather than receiving provider metadata.

`ProviderStatus.state` adds `limited` and `not-entitled`. Additive optional fields:
`signedIn: boolean`, `availability: 'available' | 'blocked' | 'unknown'`, and
`failure: ProviderFailure`. Do not infer available allowance from `state: 'ready'`:
ready means signed in with no known blocking condition; it is not a Send gate for Codex. Unknown allowance remains
unknown. A failed or timed-out allowance read preserves `state: ready`, `signedIn: true`,
and `availability: unknown` after sign-in is established. Allowance reads have a
1.5-second advisory timeout and never pre-gate Codex Send.
API mode retains its existing status and model API.

`provider.setModel(null)` restores the account default. Currently only Codex has
model discovery/selection support here. Claude and legacy API return an empty
subscription catalog and return a failure result when setting a subscription model; API mode continues
to use `desktopApi.model.get/set`. Codex selections are validated against a fresh
catalog before saving. A disappeared preference falls back without deleting the
preference, so it can work again if access returns. Successful catalogs are cached
for 60 seconds, with invalidation at sign-in, provider switch, and model selection.
A generation guard prevents an in-flight stale read from repopulating invalidated
cache state. Codex Send uses one app-server process: it checks subscription auth,
reuses the catalog or reads it with a 1.5-second overall deadline, and starts its
thread/turn. It does not run `status()` or fetch allowance first. If discovery
fails, times out, or yields no usable models, Send omits the explicit model/effort
and lets the account's runtime default decide; model/entitlement errors from the
runtime remain authoritative. Explicit model discovery returns a typed failure
for a failed catalog rather than pretending to have fetched options. Model setting applies to the
next run; it does not mutate an in-flight thread or clear history. Existing
provider-switch cancellation/history clearing is unchanged.

The catalog cache is keyed on the provider only, which is enough while the app has a
single account per provider. If sign-out or account switching is ever added, the cache
(and the saved model preference it validates) must be keyed on account identity, or
cleared at that point, so one account's model list is never offered to another.

The settings v2 file adds `providerModels: Partial<Record<ProviderId, string>>`.
This field is Zod validated, bounded to safe model slugs, and persisted through the
existing serialized atomic writes. Old v1/v2 API model settings are retained.

The chat error event and unsuccessful send result add optional `resetsAt`.
New codes: `usage_limit`, `plan_not_entitled`, `model_unavailable`, `auth_expired`,
`runtime_unavailable`. Existing authentication and generic API codes still apply.
The banner displays app-authored copy (including local reset time and the date when not today) and
opens Settings for these codes. No raw JSON-RPC data, provider prose, credentials,
account email, filesystem paths, or tool input is forwarded as error detail.
Known error categories and reset timestamps are retained instead.

## Verified pinned runtime schemas

Verified locally against the bundled `@openai/codex` **0.162.1**, without credentials:

```sh
pnpm exec codex app-server generate-ts --out /tmp/desktop-plan-schema
```

Generated v2 types used:

- `ModelListParams`: `cursor?: string | null`, `limit?: number | null`,
  `includeHidden?: boolean | null`.
- `ModelListResponse`: `data: Model[]`, `nextCursor: string | null`.
  `Model` supplies `model`, `displayName`, `hidden`, `isDefault`,
  `defaultReasoningEffort`, and `supportedReasoningEfforts[].reasoningEffort`.
  Pagination is bounded and repeated cursors fail closed.
- `ThreadStartParams`: explicit `model`, plus
  `config.model_reasoning_effort` using the catalog default.
  `ThreadStartResponse.model` records the resolved model separately from preference.
  The native local-server tool roundtrip asserts both model and effort resolution.
- `GetAccountRateLimitsParams`: `excludeResetCreditDetails?: boolean`,
  `supportsLunaReserve?: boolean`. We pass only `excludeResetCreditDetails: true`;
  we do not opt into reserve fallback, credits purchase, or reset-credit redemption.
- `GetAccountRateLimitsResponse`:
  - `ordinaryUsageAllowed: boolean | null`: backend permission for ordinary included
    usage validated against the active account. `false` reports limited, `true`
    available, `null` unknown. Clients must not infer recovery from percentages or
    reset dates. Neither this status nor percentages pre-gate Codex Send.
  - `rateLimits: RateLimitSnapshot`,
    `rateLimitsByLimitId: Record<string, RateLimitSnapshot> | null`.
  - `rateLimitResetCredits: RateLimitResetCreditsSummary | null`: available count
    and nullable detail rows. We do not redeem reset credits or expose these rows.
  - `accountId: string | null`, `rateLimitUpsell: JsonValue | null`: backend-owned
    identity/banner metadata, deliberately not exposed to the renderer.
  - Snapshot fields: `limitId`, `limitName`, `normalModelSlug`, `planType`,
    `primary`, `secondary`, `credits`, `individualLimit`, `spendControlReached`,
    and `rateLimitReachedType`.
    `credits` is `{ hasCredits: boolean; unlimited: boolean; balance: string | null } | null`.
    `hasCredits || unlimited` reports available even when ordinary included usage
    is exhausted. Balance is not exposed or interpreted as a numeric quota.
    `individualLimit` is a nullable spend-control snapshot with string `limit` and
    `used`, numeric `remainingPercent` and Unix-second `resetsAt`; it is not used
    to guess permission. The spend-control/reached flags are not Send gates.
  - Primary/secondary windows contain `usedPercent`, `windowDurationMins`, and
    `resetsAt` (Unix seconds). We expose bounded remaining percentages and
    plausible reset dates as advisory display values only. Expiry of a displayed
    reset never changes Codex availability without a new backend permission read.
- `TurnError`: `message`, `codexErrorInfo`, `additionalDetails`.
  `ErrorNotification`: `error: TurnError`, `willRetry`, `threadId`, `turnId`.
  JSON-RPC error `data` is classified before the transport discards it. Structured
  `usageLimitExceeded`, `rateLimitExceeded`, `unauthorized`, upstream HTTP statuses,
  and safe reset fields are recognized. JSON detail strings can carry reset fields.

`remote_models` is enabled to permit fresh account-aware remote catalog discovery
instead of deliberately restricting the runtime to its bundled catalog. No tool,
network search, plugin, environment, native shell or filesystem capability is
enabled by this change. Native isolation and app-tool bridge tests run on Linux,
Windows, and against the packaged Windows runtime. The runtime may use its own
cached/bundled catalog if remote discovery is unavailable; catalog presence is
not conclusive proof of entitlement. Runtime entitlement errors remain authoritative.

Default order: server `isDefault`, then listed `gpt-5.6-terra`, then the first
visible listed model. Explicit discovery of an empty catalog returns `model_unavailable`; Send can
still delegate to the runtime default without guessing an explicit model. Terra is documented for Codex Free/Go in
[OpenAI's plan/model guidance](https://help.openai.com/en/articles/20001354).
No real Free account or live model request was used to verify entitlement.

Native tests also verify signed-out Claude `auth status` JSON (exit 1 is accepted
only for that metadata command, while other nonzero runtime exits still fail).

For Claude Code **2.1.299** / Agent SDK **0.3.299**, the installed SDK declarations
verify `accountInfo().subscriptionType`, `SDKRateLimitEvent.rate_limit_info`
(`status: allowed | allowed_warning | rejected`, optional Unix-second `resetsAt`),
assistant `error`, and error/success-subtype `result` with `is_error` and
`errors`/`result`. Free is rejected before releasing gated prompt input. API-key
and third-party authentication continue to be refused before prompt input.

Claude has no supported standalone allowance-read endpoint in this integration.
Its allowance response has no windows: plan comes from `auth status` when
reported or SDK account info after a run; limit state comes from the last error.
Neither remaining percentage nor a reset time is invented. Remembered regex/free-text
plan or limit errors, including JSON-looking result text, are display-only: the
next explicit Send proceeds. Only structured Free subscription metadata (auth
status or SDK account info) gates entitlement. Only a structured `rate_limit_event`
with `status: rejected` and a plausible future reset can gate a later Send, until
that reset. Allowed events or successful results clear the trusted limit and
remembered failure. Historical state is in memory and resets on sign-in/restart.

All reset fields are clamped to now minus one hour through now plus eight days;
outliers, non-finite values and invalid dates are dropped. A day beyond today is
included in error copy. Numeric HTTP statuses use structured `httpStatusCode` or
word-bounded legacy matches, never arbitrary digit substrings. Claude's ambiguous
`billing_error` gets a neutral `api` failure, because it does not establish quota
exhaustion or plan entitlement. It cannot create a Send gate. Claude Free/limit/
result variants use mocks; live Free sign-in behavior remains unverified.

There is no app-level retry/resend loop in the subscription runners or chat
session. A terminal runtime notification/result settles the run and closes the
runtime. Codex error notifications marked `willRetry: true` are ignored so the
runtime can complete its existing turn; the app does not reissue it. Tests assert one turn/query on quota failures. Vendor-internal transport
retry behavior is outside this guarantee; Desktop Agent does not reissue the
user request automatically.
