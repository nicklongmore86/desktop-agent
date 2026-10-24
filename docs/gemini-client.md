# Gemini API-key client

`src/main/llm/gemini/` is an `AgentClient` (see `src/main/agent/types.ts`) over the Google Gemini API, so `createAgent` runs its tool loop unchanged with a Gemini API key, either a free AI Studio key or a paid one. It is not wired into settings or the UI yet: the connection-model PR adds the adapter registry and will use it.

**Policy:** API keys only. Signing in with a Google account (Gemini CLI or Antigravity OAuth, Google AI Pro/Ultra plans) is not permitted and must not be added.

## API

```ts
import {
  createGeminiClient,
  listGeminiModels,
  validateGeminiKey,
  geminiErrorEvent,
  GEMINI_FREE_TIER_NOTICE,
} from './llm/gemini'

const client = createGeminiClient({ apiKey, model: 'gemini-2.5-flash' })
const agent = createAgent({ client, tools, model: 'gemini-2.5-flash' })
```

- `createGeminiClient({ apiKey, model, fetch? })`: `messages.stream(params, { signal })` returns an `AgentStream` (`on('text')`, `finalMessage()`, `abort()`). The client's own `model` is used for every request, whatever `params.model` says. `fetch` exists for tests only. The host is fixed and there is no base-URL option.
- `listGeminiModels(apiKey)`: calls `models.list`, follows the pages, and keeps the models whose `supportedGenerationMethods` include `generateContent`.
- `validateGeminiKey(apiKey)`: checks a key by calling `models.list` only. It never runs a generation, so it does not spend generation quota.
- `GeminiError` / `geminiErrorEvent(error)`: every failure is a `GeminiError` with an `AgentErrorCode`, a user-safe message and, for quota errors, `resetsAt`.
- `GEMINI_FREE_TIER_NOTICE`: the data-use notice the UI must show for free keys (see below).

## Transport

- `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse`, read as server-sent events ([generateContent reference](https://ai.google.dev/api/generate-content#method:-models.streamgeneratecontent)).
- The key goes in the `x-goog-api-key` header ([quickstart REST examples](https://ai.google.dev/gemini-api/docs/quickstart)) and never in the URL. Redirects are refused (`redirect: 'error'`). The model name is checked against `[A-Za-z0-9._-]` before it goes into the path.
- If the stream sends nothing for 120 s, the request fails as `network`. The client does not retry: a `429` comes back with `resetsAt` for the caller to show.

## Translation (Anthropic `MessageParam[]` ⇄ Gemini `Content[]`)

The canonical transcript stays in Anthropic format. Everything below happens inside the client.

| Anthropic                       | Gemini                                                                                                                                                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `system`                        | `systemInstruction.parts[].text`                                                                                                                                                                                    |
| `user` / `assistant`            | `user` / `model`. Neighbouring turns with the same role are merged, and turns left with no parts are dropped.                                                                                                       |
| `text`                          | `{ text }`                                                                                                                                                                                                          |
| `tool_use`                      | `{ functionCall: { id?, name, args } }` plus `thoughtSignature`                                                                                                                                                     |
| `tool_result`                   | `{ functionResponse: { id?, name, response: { output } \| { error } } }` in a `user` turn. `is_error` results go under `error`, so they stay visible as errors.                                                     |
| `image`                         | `inlineData` (PNG, JPEG, WebP); a GIF or a remote image becomes a text placeholder. In a tool result: `functionResponse.parts` on Gemini 3+, otherwise inline parts after the responses (`docs/provider-images.md`) |
| `document`                      | A text placeholder (`[Attachment omitted: not sent to Gemini]`)                                                                                                                                                     |
| `thinking`, `redacted_thinking` | Dropped                                                                                                                                                                                                             |
| `tools[].input_schema`          | `tools[0].functionDeclarations[].parameters` (OpenAPI subset, see below). A tool with no properties gets no `parameters`.                                                                                           |
| `max_tokens`                    | `generationConfig.maxOutputTokens`                                                                                                                                                                                  |

Function declarations use "a select subset of the OpenAPI schema format" ([function calling](https://ai.google.dev/gemini-api/docs/generate-content/function-calling)), described by the `Schema` type in the [API reference](https://ai.google.dev/api/generate-content). `schema.ts` converts each schema as follows:

- Types become upper case.
- `["T","null"]` becomes `nullable`. Multi-type unions and `oneOf` become `anyOf`.
- `allOf` is merged, and local `$ref`s (`#/$defs`, `#/definitions`) are resolved. Recursive or external refs become `STRING`.
- `const` becomes a one-value `enum`. Non-string enums are moved into the description.
- `exclusiveMinimum` and `exclusiveMaximum` become inclusive bounds.
- Unsupported `format` values are dropped. `additionalProperties`, `patternProperties`, `$schema`, `uniqueItems` and similar keywords are dropped too.
- `required` keeps only properties that exist, without duplicates.
- Conversion stops at depth 24.

Dropping a keyword only loosens what the model is told. Every tool still validates its own input before it runs.

### Replies

- Text parts stream to `on('text')` and are merged into one `text` block. `thought: true` parts are skipped.
- Each `functionCall` becomes a `tool_use` with a synthetic id, `toolu_gemini_<24 hex>`. That id is stable for the life of the client, which keeps a map from it to Gemini's own call `id` and the part's `thoughtSignature` (it remembers the most recent 2,000 calls). Every `functionResponse` sent back carries the matching Gemini `id`.
- A call whose `args` is not a JSON object, a call with no name, and `finishReason: MALFORMED_FUNCTION_CALL` all raise a `protocol` error, so nothing runs. When function calls are cut off by `MAX_TOKENS`, the stop reason is `max_tokens`, and the agent's existing guard discards them.

| `finishReason`                                                                                                                                                                             | `stop_reason`                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `STOP`                                                                                                                                                                                     | `tool_use` if the reply contains function calls, else `end_turn` |
| `MAX_TOKENS`, `CONTINUATION`                                                                                                                                                               | `max_tokens`                                                     |
| `SAFETY`, `RECITATION`, `PROHIBITED_CONTENT`, `BLOCKLIST`, `SPII`, `IMAGE_SAFETY`, `IMAGE_PROHIBITED_CONTENT`, `IMAGE_RECITATION`, `PUP_LIMITED_DISABLED`, or `promptFeedback.blockReason` | `refusal`                                                        |
| `MALFORMED_FUNCTION_CALL`, `MISSING_THOUGHT_SIGNATURE`                                                                                                                                     | `protocol` error                                                 |
| anything else (`OTHER`, `LANGUAGE`, …)                                                                                                                                                     | `null` (the agent reports `protocol`)                            |
| stream ends with no finish reason                                                                                                                                                          | `network` error                                                  |

The values come from [FinishReason](https://ai.google.dev/api/generate-content#FinishReason).

Usage is mapped from `usageMetadata`:

- `input_tokens` = `promptTokenCount` + `toolUsePromptTokenCount` − `cachedContentTokenCount`
- `cache_read_input_tokens` = `cachedContentTokenCount`
- `output_tokens` = `candidatesTokenCount` + `thoughtsTokenCount`. Thinking is billed as output, and it is also reported as `output_tokens_details.thinking_tokens`.

### Thought signatures

The [thought signatures guide](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures) says:

- On Gemini 3 and later, the first `functionCall` part of each step carries a `thoughtSignature`. In parallel calls, only the first one does.
- "You must pass back thought signatures during function calling, otherwise you will get a validation error" (400). Validation covers every step of the current turn.
- Signatures on parts other than function calls are optional to return.
- For function calls that this client did not receive, you may send `skip_thought_signature_validator` instead.

How the client applies this:

- Signatures live only in the client's in-memory map. They are never written into the `MessageParam` transcript, events or the UI, and they are re-attached to the matching `functionCall` parts on every later request.
- When a model turn's calls have no known signature, the first call gets the documented skip value. This covers history loaded from disk, calls the client has forgotten, and calls made by another provider.
- Text-part signatures are not kept. Dropping them is allowed, though Google says reasoning quality may drop slightly.

## Errors

These follow the [troubleshooting guide](https://ai.google.dev/gemini-api/docs/troubleshooting) and the [API errors guide](https://ai.google.dev/gemini-api/docs/api-errors).

| Response                                                                                                   | `AgentErrorCode`                                                                                                     |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 400 with `ErrorInfo.reason = API_KEY_INVALID` or "API key not valid", 401, 403 for a leaked or invalid key | `authentication`                                                                                                     |
| 400 for input over the token limit                                                                         | `context_limit`                                                                                                      |
| any other 400 (also 413, 416)                                                                              | `invalid_request`, with a sanitised detail                                                                           |
| 402 (prepaid credits used up)                                                                              | `usage_limit`                                                                                                        |
| 403                                                                                                        | `permission`                                                                                                         |
| 404                                                                                                        | `model_unavailable`                                                                                                  |
| 429 / `RESOURCE_EXHAUSTED`                                                                                 | `rate_limit`, or `usage_limit` for per-day quotas (`QuotaFailure` quota id containing `PerDay`, or `quota_exceeded`) |
| 503 / `UNAVAILABLE`                                                                                        | `overloaded`                                                                                                         |
| other 5xx                                                                                                  | `api`                                                                                                                |
| fetch failure, stalled stream, redirect                                                                    | `network`                                                                                                            |
| caller's signal                                                                                            | `aborted`                                                                                                            |

For 429s, `resetsAt` = now + `RetryInfo.retryDelay`, or `Retry-After` when that is absent.

Error messages are fixed English strings. Some add a short server detail, which is:

- limited to one line and 160 characters
- stripped of control characters
- stripped of the key itself, anything shaped like a Google key (`AIza…`), and `key=` or `access_token=` query values.

Raw responses are never logged.

## Free-tier data use

Google's [pricing page](https://ai.google.dev/gemini-api/docs/pricing) says free-tier content is "Used to improve our products" and paid-tier content is not. The [Gemini API terms](https://ai.google.dev/gemini-api/terms) have the details. `GEMINI_FREE_TIER_NOTICE` carries that warning and both links, for the settings UI to show when a key is added.

## Known gaps

- **Error routing in the agent loop:** `createAgent` maps thrown errors with the Anthropic-specific `apiErrorEvent`, so a `GeminiError` currently surfaces as the generic `api` error with a "Claude" message. The wiring PR should route errors through `geminiErrorEvent` (or the adapter's own mapper). Until then, the codes listed in the Errors table are only reachable by calling the client directly. Malformed calls still never execute.
- The agent loop's stop-reason messages say "Claude". That is outside this module.
- There is no automatic retry or backoff, no thinking-budget control and no context caching. Images are sent only when the agent loop has them (a vision model; see `docs/provider-images.md`).
