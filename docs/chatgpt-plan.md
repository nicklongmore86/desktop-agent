# ChatGPT · Plan

`chatgpt-plan` uses a ChatGPT Plus or Pro plan directly: **Sign in with ChatGPT**
(`src/main/providers/chatgpt-auth`) for the tokens and the Responses API client
(`src/main/llm/openai-responses`) for chat, under the app's own agent loop, so tools,
approvals and the audit log are the same as every other connection. The adapter is
`src/main/providers/adapters/chatgpt-plan.ts`.

It is a separate connection from **Codex · ChatGPT** (`codex-subscription`), which is
unchanged. The wizard offers it as ChatGPT → **Plan**, with the note "Documented for
ChatGPT Plus and Pro"; ChatGPT Free and the other plans keep using Free / Subscription
(Codex).

## What runs where

| Step                  | Where                                                         | What the renderer sees                       |
| --------------------- | ------------------------------------------------------------- | -------------------------------------------- |
| Sign in               | main: loopback listener + system browser                      | `provider.login()` / `cancelLogin()`, status |
| Tokens                | main: `userData/secrets/chatgpt-plan.enc` (safeStorage)       | never                                        |
| Registration          | `settings.json` `chatgptAuth` (host id, client ids)           | never (no token there)                       |
| Chat                  | main: `POST /v1/responses`, token as the Authorization header | text and tool events                         |
| Models                | main: `GET /v1/models`                                        | slugs and display names                      |
| Remove the connection | main: revoke at OpenAI, delete the tokens                     | `notice` if revocation is unconfirmed        |

- `authKind` is `chatgpt-login`. The sign-in panel shows OpenAI's **Continue with ChatGPT**
  button (`data-sign-in="chatgpt"`) and **Cancel sign-in** while it waits. There is no
  link or code to paste: main waits on its own loopback listener.
- The API key calls refuse this connection (`authKind` is not `api-key`), so its token
  file can never be read through them.
- Status is read from the saved sign-in only (no request): signed out, ready, or "sign in
  again" with the reason (ended, plan use not allowed, unreadable). A run that OpenAI
  refuses for the sign-in, or for the plan, is remembered until the next sign-in or reply.
- There is no usage report: Settings shows the model picker and no usage bars. A limit
  shows as an error when it is reached.

## Errors

| When                                                        | Code                | Message (written in the app)                                                                                        |
| ----------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Not Plus or Pro (`subscription_sharing_user_not_eligible`)  | `plan_not_entitled` | Needs ChatGPT Plus or Pro. On other plans, use Codex · ChatGPT or an OpenAI API key instead.                        |
| Limit reached (`subscription_sharing_usage_limit_exceeded`) | `usage_limit`       | … Choose Manage usage to review it at https://chatgpt.com/settings/usage.                                           |
| Refresh refused, sign-in ended, token rejected              | `auth_expired`      | Your ChatGPT sign-in has ended. Sign in with ChatGPT again.                                                         |
| Tool definitions rejected                                   | `invalid_request`   | ChatGPT plan use did not accept this app's tool format (`<field>`), so nothing was run. Please report this problem. |

A tool-format rejection is a 400/422 (or an in-stream failure) whose `error.param` names
`tools…` or a replayed call's `input[n].namespace`/`name`, or an
`subscription_sharing_unsupported_capability` naming one. The field path is checked
against a strict pattern before it is shown; the provider's own text never is. Main also
logs `chatgpt-plan: tool format rejected (param=…, request=…)`.

### Details in error messages

Every ChatGPT error message, including the ones above, ends with app-written details, for
example `Details: HTTP 400, application/json, code invalid_value, param model, request req_123.`
Only these appear:

- the HTTP status;
- the media type, by name only for well-known ones, otherwise "other content type" or
  "no content type";
- what the body was when it was not a stream ("body detail", "body other JSON", "body
  not JSON", "body empty", "body too large", "body response in_progress");
- `error.code` (snake_case words), `error.type` (OpenAI's fixed set only), `error.param`
  (a lowercase field path such as `tools[0].type`);
- the request id (`req_` plus up to 64 letters and digits).

A value is also dropped when it contains the access token sent with that request, or
shares any 8-character run with it (ignoring case). Refresh and id tokens are never sent
to `api.openai.com`, so a response cannot echo them. OpenAI's own text never appears. The
details are trimmed to fit the 300-character message, leaving out the type, then the
media type, the body kind and the param before the code, request id and status.

### Responses that are not a plain event stream

- `text/event-stream` is matched in any case and with any parameters (`; charset=utf-8`).
  The OpenAI-compatible client (`openai-compat/client.ts`) uses the same check.
- No `Content-Type`: the first bytes are checked, and a body that starts like SSE
  (`data:`, `event:`, `id:`, `retry:` or a `:` comment) is still read as a stream.
- A complete Responses object (`object: "response"`) sent as JSON is accepted on the same
  terms as the stream's terminal event: `completed` or `incomplete` only; `failed` maps its
  error code.
- A 2xx JSON `error` object maps by its code. Anything else is "ChatGPT did not stream its
  response …" with the details above.
- A non-stream body is read whole up to 8 MiB; a longer one is refused ("body too large"),
  never cut and parsed. Error bodies (any client) are capped at 64 KiB the same way.

## Screens (Sign in with ChatGPT UI)

Follows OpenAI's published guidance: <https://developers.openai.com/siwc/ui-ux-guidelines>,
<https://developers.openai.com/siwc/quickstart> and
<https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt>.

- **Button**: `components/chatgpt-plan/ChatgptButton.tsx`, labelled **Continue with ChatGPT**
  (OpenAI's label for the action that starts sign-in; the dialog stays "Sign in with
  ChatGPT"). It keeps `data-sign-in="chatgpt"`. The logo is OpenAI's own file
  (`assets/openai/chatgpt-logo-white.svg`, see THIRD-PARTY-NOTICES.md), drawn through a CSS
  mask, so the fill follows the theme (dark button on light, light button on dark) and
  High Contrast uses system colours.
- **First-use notice** (`PlanNotice`): "You’re using your ChatGPT plan" with **Got it** and
  Manage usage, shown once per connection after the first sign-in, once the wizard and
  Settings are closed. OpenAI asks for it on the first sign-in only, so a later sign-in does
  not show it again. The flag is `plan-notice-seen:chatgpt-plan` in `localStorage`
  (kept after Remove). An open approval hides it and has focus first.
- **Composer label**: "Using ChatGPT plan" + **Manage usage** beside the pickers while the
  connection in use is `chatgpt-plan` and not signed out.
- **Manage usage** is a link to the fixed `MANAGE_USAGE_URL`
  (`src/shared/chatgpt-plan.ts`, also used by main's error text), opened by the main
  process's window-open handler like every other link. No URL from a response is used.
- **Errors**: `usage_limit` and `plan_not_entitled` banners on this connection show Manage
  usage as the primary action, before Open Settings.
- **Codex invitation** (`PlanSwitchBanner`): shown while Codex · ChatGPT is in use and
  ChatGPT · Plan is not ready; dismissible (`plan-switch-banner-dismissed`); its action
  opens the wizard on ChatGPT · Plan's sign-in. Codex itself is unchanged.

## Verifying with a real account (Windows)

The tests use fake OAuth and Responses servers. The open question only a real account can
answer is whether OpenAI accepts our tool grouping: one `namespace` tool named `workspace`
holding every function, each with `strict: false`. To check it:

1. Build and install (or `pnpm dev`) on Windows. Use a ChatGPT **Plus or Pro** account.
2. Settings → Accounts & providers → **Add connection** → ChatGPT → **Plan** → Continue.
3. Click **Continue with ChatGPT**. Your browser opens OpenAI's sign-in. Sign in and allow
   Desktop Agent to use your plan. The wizard shows **Connected**. (Also try **Cancel
   sign-in** once while the browser is open: the wizard says "Sign-in cancelled." and
   nothing is saved.)
4. Pick a model, then on the folder step choose a small folder (for example
   `C:\Users\<you>\Documents\test-folder` with two or three files). Finish.
5. In the chat, send: **"List the files in my granted folder."**
6. Expected: the activity shows a `list_dir` (or `list_granted_folders`) tool call and the
   reply names your files. That means the namespace and non-strict tools were accepted.
7. If instead the chat shows **"ChatGPT plan use did not accept this app's tool format
   (…)"**, note the field in brackets (for example `tools[0].type`) and report it. With
   `pnpm dev`, the terminal also shows the `chatgpt-plan: tool format rejected (param=…,
request=…)` line; the request id helps OpenAI find the request.
8. If the chat shows an error instead, copy the whole message, including the
   `Details: …` part (HTTP status, content type, body kind, code, param, request id). It
   holds no token or OpenAI text and tells us what OpenAI answered.
9. Also check: ask it to create a file in the folder (an approval appears; approve it), and
   Settings shows the model picker and no usage bars.
10. Remove the connection (switch to another first): Settings → ChatGPT · Plan → Remove.
    `%APPDATA%\desktop-agent\secrets\chatgpt-plan.enc` is gone, your ChatGPT chats are
    still in the history, and ChatGPT → Settings → Connected apps no longer lists Desktop
    Agent (if it does, the app said it could not confirm sign-out).

Nothing in these steps puts a token in a URL, `settings.json`, the renderer or a log.
