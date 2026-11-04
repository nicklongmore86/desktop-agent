# OpenAI-compatible model client

`src/main/llm/openai-compat/` provides an `AgentClient` (the interface `createAgent` already uses) over the **Chat Completions streaming API**, so the existing tool loop runs unchanged against OpenAI, Ollama, LM Studio and OpenRouter. The transcript stays in Anthropic `MessageParam[]` form; the client translates both ways internally.

It is not wired into settings or the provider service yet. The connection registry will construct it.

## API

```ts
createOpenAICompatClient({ baseUrl, apiKey?, model, flavor, fetch?, timeoutMs? }): AgentClient
listOpenAICompatModels({ baseUrl, apiKey?, flavor, fetch?, signal? }): Promise<OpenAICompatModel[]>
validateOpenAICompatKey({ baseUrl, apiKey?, flavor, fetch?, signal? }): Promise<KeyValidation>
openAICompatErrorEvent(error): AgentEvent // { type: 'error', code, message, resetsAt? }
```

- `flavor`: `'openai' | 'ollama' | 'lmstudio' | 'openrouter'`.
- `model` replaces the `model` that `createAgent` puts in each request.
- `timeoutMs` (default 120 s) is an idle timeout. It resets on every received chunk, so long generations are not cut off.
- Every failure rejects `finalMessage()` with an `OpenAICompatError` (`code: AgentErrorCode`, `status?`, `resetsAt?`).

## Base URL rules

| Flavor     | Scheme  | Hosts                           | Bare origin becomes |
| ---------- | ------- | ------------------------------- | ------------------- |
| openai     | `https` | `api.openai.com` (default port) | `/v1`               |
| openrouter | `https` | `openrouter.ai` (default port)  | `/api/v1`           |
| ollama     | `http`  | `127.0.0.1`, `::1`, `localhost` | `/v1`               |
| lmstudio   | `http`  | `127.0.0.1`, `::1`, `localhost` | `/v1`               |

These are also rejected: credentials in the URL, query strings and fragments. Rejections never echo the URL. The network layer (`docs/network.md`) refuses redirects whatever a request asks, and any 3xx is an error, so a redirect can never carry the key to another host.

## Translation

| Anthropic transcript             | Chat Completions                                                                                                                                                                       |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `system` (string or text blocks) | one `role: 'system'` message                                                                                                                                                           |
| text blocks                      | `content` string (blocks joined with blank lines)                                                                                                                                      |
| `tools[].input_schema`           | `tools: [{ type: 'function', function: { name, description, parameters } }]`                                                                                                           |
| assistant `tool_use`             | assistant `tool_calls[{ id, type: 'function', function: { name, arguments: JSON } }]`, `id` = the call's request alias (see Tool call ids)                                             |
| user `tool_result`               | `role: 'tool'` messages (before any other user text), `tool_call_id` = the alias of `tool_use_id`                                                                                      |
| `tool_result.is_error: true`     | content prefixed with `[tool error] ` (tool messages have no error flag)                                                                                                               |
| image blocks                     | `image_url` parts with a `data:` URL; in a tool result, a `user` message after the `tool` messages, marked as tool output (`docs/provider-images.md`). A remote image is a placeholder |
| document blocks                  | a placeholder sentence. The data is never sent.                                                                                                                                        |
| thinking / redacted thinking     | dropped                                                                                                                                                                                |
| `max_tokens`                     | `max_completion_tokens` (openai: `max_tokens` is deprecated there), else `max_tokens`                                                                                                  |

Requests always set `stream: true` and `stream_options: { include_usage: true }`.

Responses: `delta.content` fragments are emitted as `text` events and concatenated. `delta.tool_calls` fragments are assembled by `index`, with the `id` and name taken from the first fragment. Arguments must parse to a JSON object. If they don't and the turn ends in tool use, `finalMessage()` rejects with `protocol` and the tool is never run. Empty arguments become `{}`. Provider tool ids matching `^[A-Za-z0-9_-]{1,64}$` are kept. Any other id, or a missing one, becomes `call_<sha256 prefix>`. That form is stable and also valid for Claude, so a transcript can move between providers. A returned id that the history already uses (as a call or a result) is never reused: it also becomes a fresh `call_<sha256 prefix>`, so two calls never share a saved id.

| `finish_reason`                | `stop_reason`                                               |
| ------------------------------ | ----------------------------------------------------------- |
| `stop`                         | `end_turn` (`tool_use` if complete tool calls came with it) |
| `tool_calls` / `function_call` | `tool_use`                                                  |
| `length`                       | `max_tokens` (the loop discards partial tool calls)         |
| `content_filter`               | `refusal`                                                   |
| `error` (OpenRouter)           | rejects with the mapped error                               |
| none before the stream ends    | rejects with `network`                                      |

Usage: `input_tokens = prompt_tokens − cached_tokens`, `cache_read_input_tokens = prompt_tokens_details.cached_tokens`, `output_tokens = completion_tokens`.

## Tool call ids

A saved chat holds the tool ids of whichever connector made each turn: `toolu_…` (Anthropic API), `toolu_gemini_<24 hex>` (Gemini), UUIDs (the Claude subscription and Codex bridges), and the kept or hashed ids above (this client and the Responses client). Some routes refuse ids in a foreign format or over a length, so saved ids are never sent. `tool-ids.ts` aliases them for each request instead:

- Every saved id becomes `call` plus five base-36 digits (`call00000`, `call00001`, …), numbered by first appearance in the history. The alias is nine ASCII letters and digits, which meets every rule below and Claude's `^[a-zA-Z0-9_-]+$`.
- The same history gives the same aliases on every turn, so the request prefix stays the same and provider prompt caching keeps working.
- Aliases exist only in the request. They are never saved, logged or shown. The ids the provider returns are for new calls, so they never map back to an earlier call. They become new saved ids as described under Responses above.
- A call and its result always get the same alias. A `tool_result` that does not answer, exactly once, a call of the assistant message just before it is refused with `protocol` ("The conversation has a tool result without its tool call"). The request is not sent.

The ChatGPT plan (Responses) client aliases `call_id` the same way, and applies the same pairing check. Its in-memory reasoning items are still looked up by saved id.

Id limits, checked 2026-11-02:

- **Responses API**: `function_call_output.call_id` is documented as `minLength: 1`, `maxLength: 64` (`FunctionCallOutputItemParam` in [openai-openapi](https://github.com/openai/openai-openapi) `openapi.yaml`, spec version 2.3.0).
- **Chat Completions**: the spec gives no length or pattern for `tool_calls[].id` or `tool_call_id`. Several third-party reports say OpenAI rejects ids over 40 characters with `string_above_max_length` on `messages[n].tool_calls[0].id`. This is unverified against OpenAI's own documentation. Aliases are far below both limits.
- **OpenRouter**: some Mistral routes require 9-character alphanumeric ids, which the aliases are.

`src/main/llm/cross-provider/` replays one saved chat per connector through every translator (Anthropic, openai-compat, Responses, Gemini) and through the bridge transcript prompt. Each chat has tool calls, tool results, untrusted-content markers and an attachment. For every pair, the tests check:

- calls and results pair exactly;
- the markers survive;
- Gemini calls with no known signature carry `skip_thought_signature_validator`;
- no thinking, signatures, encrypted reasoning or credentials appear.

## Errors

Messages are fixed, app-written text, capped at 300 characters. Provider response text is never forwarded. For example, OpenAI's 401 body repeats the submitted key (`Incorrect API key provided: sk-…`).

| Condition                                                     | Code                                                                                        |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 401                                                           | `authentication`                                                                            |
| 402 (OpenRouter credits), 429 `insufficient_quota`            | `usage_limit`                                                                               |
| 403                                                           | `permission`                                                                                |
| 404, or a `model_not_found` code                              | `model_unavailable`                                                                         |
| 400/413 with `context_length_exceeded` or context-length text | `context_too_long`                                                                          |
| 429                                                           | `rate_limit`, with `resetsAt` from `retry-after-ms`, `retry-after` or `x-ratelimit-reset-*` |
| other 400/413/422                                             | `invalid_request`                                                                           |
| 503, 529                                                      | `overloaded`                                                                                |
| other 5xx, 3xx                                                | `api`                                                                                       |
| connection failure, 408, idle timeout, truncated stream       | `network`                                                                                   |
| caller abort or `stream.abort()`                              | `aborted`                                                                                   |
| malformed SSE JSON, invalid tool arguments, non-streamed 200  | `protocol`                                                                                  |

`createAgent` currently maps thrown errors with `apiErrorEvent`, which only knows Anthropic SDK errors, so an `OpenAICompatError` surfaces there as `api`. The wiring PR should recognise `OpenAICompatError` and use `openAICompatErrorEvent(error)` instead. `aborted` is unaffected.

## Models and key validation

- `listOpenAICompatModels` calls `GET {base}/models`.
  - **OpenRouter**: only models whose `supported_parameters` includes `"tools"` (`toolSupport: 'supported'`).
  - **Ollama / LM Studio**: every model, with `toolSupport: 'unknown'`.
  - **OpenAI**: every model except families that cannot chat (embeddings, whisper, tts, image, moderation, transcribe/realtime/audio variants), with `toolSupport: 'unknown'`.
- `validateOpenAICompatKey` never sends a completion. It uses `GET /models`, except for OpenRouter. OpenRouter's `/models` is public and returns 200 for any key (checked 2026-10-17), so its key is checked with `GET /api/v1/key`, which returns only the key's own metadata.

## Not supported

- Documents (replaced by a placeholder), extended thinking/reasoning content, and Anthropic server tools. Images are sent only to a model the connection says can see them.
- `tool_choice` and `parallel_tool_calls` are not sent: Ollama does not support `tool_choice`.
- Non-streaming servers: a 200 response that is not `text/event-stream` is a `protocol` error.
- Prompt caching: `cache_control` markers are dropped. Cached-token counts are still reported where the provider returns them.
- A provider that requires a tool id format other than short alphanumerics. Aliases (see Tool call ids) suit OpenAI, the Responses API and the 9-character Mistral routes on OpenRouter.

## Sources

Checked 2026-10-17:

- OpenAI chunk, tool-call delta and message types: [openai-node `chat/completions.ts`](https://github.com/openai/openai-node/blob/master/src/resources/chat/completions/completions.ts). `ChatCompletionChunk.Choice.Delta.ToolCall { index; id?; type?; function?: { name?; arguments? } }`, `finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'function_call' | null`, `ChatCompletionToolMessageParam { role: 'tool'; tool_call_id; content }`, and `stream_options.include_usage`: "an additional chunk will be streamed before the `data: [DONE]` message … the `choices` field will always be an empty array".
- OpenAI reference: <https://platform.openai.com/docs/api-reference/chat/create> and <https://platform.openai.com/docs/api-reference/chat-streaming>.
- Ollama: <https://docs.ollama.com/api/openai-compatibility>. `/v1/chat/completions` supports streaming, `tools` and `stream_options.include_usage`, but not `tool_choice`. `/v1/models` is listed.
- LM Studio: <https://lmstudio.ai/docs/developer/openai-compat> (`GET /v1/models`, `POST /v1/chat/completions`, example base `http://localhost:1234/v1`) and <https://lmstudio.ai/docs/developer/openai-compat/tools>: "tool calls are sent in chunks … These chunks must be accumulated throughout the stream".
- OpenRouter:
  - [API overview](https://openrouter.ai/docs/api/reference/overview): normalized `finish_reason` values `tool_calls`, `stop`, `length`, `content_filter`, `error`; SSE comment payloads; usage in the final chunk.
  - [Errors](https://openrouter.ai/docs/api/reference/errors-and-debugging): status codes 400/401/402/403/408/429/502/503. Mid-stream errors arrive as a chunk with a top-level `error` and `finish_reason: "error"`.
  - Live `GET https://openrouter.ai/api/v1/models` has `supported_parameters` per model, including `"tools"`.
