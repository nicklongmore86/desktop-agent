# Subscription models, allowance and errors

Wave 2 should consume the types in `src/shared/ipc.ts` through
`window.desktopApi.provider`. These calls concern the currently selected provider;
ignore a response if the user switches provider while awaiting it (each response
includes `provider`). They make metadata/auth requests only; they never start a
model turn. There is no allowance polling loop. Refresh on opening Settings or on
an explicit user action. Errors from a run arrive on the existing chat event push.

## IPC contract

| Preload method                             | IPC channel          | Result                                   |
| ------------------------------------------ | -------------------- | ---------------------------------------- |
| `provider.models()`                        | `provider:models`    | `ProviderModels`                         |
| `provider.setModel(model: string \| null)` | `provider:set-model` | `ProviderModels`                         |
| `provider.allowance()`                     | `provider:allowance` | `ProviderAllowance`                      |
| `provider.get()`                           | `provider:get`       | `ProviderStatus` (additive fields below) |

```ts
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
  state: 'available' | 'limited' | 'unknown'
  resetsAt: string | null // latest known reset of blocking windows for effective model
  windows: {
    limitId: string // quota bucket plus :primary or :secondary
    remainingPercent: number // 0..100; NOT a number of requests or tokens
    resetsAt: string | null // ISO 8601 UTC
  }[]
  lastError: ProviderFailure | null // historical, not proof of current blockage
}
interface ProviderFailure {
  code: ChatErrorCode
  message: string // app-authored safe explanation
  resetsAt?: string // ISO 8601 UTC, only if supplied by runtime
}
```

`ProviderStatus.state` adds `limited` and `not-entitled`. Additive optional fields:
`signedIn: boolean`, `availability: 'available' | 'blocked' | 'unknown'`, and
`failure: ProviderFailure`. Do not infer available allowance from `state: 'ready'`:
ready means signed in with no known blocking condition. Unknown allowance remains
unknown. A failed allowance read preserves an already established sign-in state.
API mode retains its existing status and model API.

`provider.setModel(null)` restores the account default. Currently only Codex has
model discovery/selection support here. Claude and legacy API return an empty
subscription catalog and reject setting a subscription model; API mode continues
to use `desktopApi.model.get/set`. Codex selections are validated against a fresh
catalog before saving. A disappeared preference falls back without deleting the
preference, so it can work again if access returns. Model setting applies to the
next run; it does not mutate an in-flight thread or clear history. Existing
provider-switch cancellation/history clearing is unchanged.

The settings v2 file adds `providerModels: Partial<Record<ProviderId, string>>`.
This field is Zod validated, bounded to safe model slugs, and persisted through the
existing serialized atomic writes. Old v1/v2 API model settings are retained.

The chat error event and unsuccessful send result add optional `resetsAt`.
New codes: `usage_limit`, `plan_not_entitled`, `model_unavailable`, `auth_expired`,
`runtime_unavailable`. Existing authentication and generic API codes still apply.
The banner displays app-authored copy (including local reset time when known) and
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
- `GetAccountRateLimitsResponse`: `rateLimits: RateLimitSnapshot`,
  `rateLimitsByLimitId: Record<string, RateLimitSnapshot> | null`.
  Snapshot: `planType`, `normalModelSlug`, `primary`, `secondary`,
  `spendControlReached`, `rateLimitReachedType`. Each window contains
  `usedPercent`, `windowDurationMins`, `resetsAt` (Unix seconds).
  All windows are exposed; readiness considers the selected model's bucket,
  falling back to the default/aggregate snapshot when applicable. Exhausting a
  different model's bucket must not block an available selected model.
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
visible listed model. An empty catalog fails with `model_unavailable`; it does
not guess access. Terra is documented for Codex Free/Go in
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
Neither remaining percentage nor a reset time is invented. A known future reset
blocks until that time; without a reset, a new explicit Send may probe recovery.
An allowed event or successful result clears the remembered failure. Historical
state is in memory and resets on sign-in/app restart. Claude Free/limit/result
variants use mocks; live Free sign-in behavior remains unverified.

There is no app-level retry/resend loop in the subscription runners or chat
session. A rejected runtime notification/result settles the run and closes the
runtime. Tests assert one turn/query on quota failures. Vendor-internal transport
retry behavior is outside this guarantee; Desktop Agent does not reissue the
user request automatically.
