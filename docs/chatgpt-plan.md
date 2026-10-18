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

- `authKind` is `chatgpt-login`. The sign-in panel shows a plain **Sign in with ChatGPT**
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

## For the next PR (OpenAI's button, plan notice, composer label, Manage usage)

- Button artwork: replace the button marked `data-sign-in="chatgpt"` in
  `components/connections/SignInPanel.tsx` (`ChatgptSignIn`); keep its accessible name.
- One-time plan notice: show it before the first sign-in, from the wizard's connect step
  for `authKind === 'chatgpt-login'`.
- Composer label and Manage usage: the connection's `label` is "ChatGPT · Plan"; a
  `usage_limit` failure from it carries `MANAGE_USAGE_URL`
  (`llm/openai-responses/errors.ts`).

## Verifying with a real account (Windows)

The tests use fake OAuth and Responses servers. The open question only a real account can
answer is whether OpenAI accepts our tool grouping: one `namespace` tool named `workspace`
holding every function, each with `strict: false`. To check it:

1. Build and install (or `pnpm dev`) on Windows. Use a ChatGPT **Plus or Pro** account.
2. Settings → Accounts & providers → **Add connection** → ChatGPT → **Plan** → Continue.
3. Click **Sign in with ChatGPT**. Your browser opens OpenAI's sign-in. Sign in and allow
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
8. Also check: ask it to create a file in the folder (an approval appears; approve it), and
   Settings shows the model picker and no usage bars.
9. Remove the connection (switch to another first): Settings → ChatGPT · Plan → Remove.
   `%APPDATA%\desktop-agent\secrets\chatgpt-plan.enc` is gone, your ChatGPT chats are
   still in the history, and ChatGPT → Settings → Connected apps no longer lists Desktop
   Agent (if it does, the app said it could not confirm sign-out).

Nothing in these steps puts a token in a URL, `settings.json`, the renderer or a log.
