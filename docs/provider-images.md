# Images to providers

How images reach models: images a tool returns (`ToolResult.images`) and image files
the user attaches. Part 2 of the document-reading plan; `docs/document-reader.md` is the
parser that will produce tool images, `docs/attachments-conversation.md` how attachments
are saved.

## One form inside the app

Inside a request an image is an Anthropic `image` block with base64 data
(`src/main/agent/images.ts`). Each client turns it into its provider's own form, so the
agent loop, the budget and the safety checks are written once:

| Connection                                               | Tool images                                                                                                                                                                                                                                              | Attached images                                                     |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Claude · API                                             | `image` blocks inside the `tool_result`, each after an `[Image: label]` text block                                                                                                                                                                       | `image` blocks in the user message                                  |
| Claude · Subscription (Claude Code 0.3.299)              | MCP `image` content (`{ type, data, mimeType }`) in the SDK tool's result; the bundled runtime turns it into image blocks in its `tool_result`                                                                                                           | `image` blocks after the transcript text in the `SDKUserMessage`    |
| Codex · ChatGPT (Codex 0.162.1)                          | `inputImage` items (`imageUrl`: a `data:` URL) in the dynamic tool call's `contentItems` (`DynamicToolCallOutputContentItem`)                                                                                                                            | `image` items (`url`: a `data:` URL) after the text in `turn/start` |
| ChatGPT · Plan (Responses)                               | `function_call_output.output` as `input_text` and `input_image` parts. If the route refuses one such request (`invalid_request`, before anything streamed) it is sent once more with the images in a marked user message, and that client keeps doing so | `input_image` parts in the user message                             |
| Gemini                                                   | Gemini 3 and later: `functionResponse.parts[].inlineData`. Earlier models: `inlineData` parts right after the function responses, after a note marking them as tool output                                                                               | `inlineData` parts. GIF (not read by Gemini) becomes a placeholder  |
| OpenAI, OpenRouter, Ollama, LM Studio (Chat Completions) | `tool` messages carry text only; the images follow in one `user` message, introduced as tool output (not the user's words, data not instructions), each after its label                                                                                  | `image_url` parts (`data:` URLs) in the user message                |

Image blocks with a remote URL source are never passed on: the app only sends bytes it holds.

## Which connections see images

Main decides (`src/main/providers/vision.ts`, `ConnectionAdapter.vision`), the same way
for the composer's chips and for each Send, and the renderer only shows it
(`connections.vision(id)`):

- **Claude · API, Claude · Subscription**: always (every Claude model offered reads images).
- **Codex**: the runtime catalog's `inputModalities` for the selected model (the
  protocol's default for a missing list is text and image). The runner reads it from its
  own catalog call during the run; a catalog that cannot be read means no images.
- **ChatGPT · Plan**: the model list's `input_modalities` when an entry has it, else
  OpenAI's documented families (below), else the setting.
- **OpenAI**: the documented families (GPT-4o, 4.1, 4.5, 4 Turbo, GPT-5 and later, o1,
  o3, o4-mini read images; GPT-3.5, GPT-4, o1-mini, o1-preview, o3-mini, gpt-oss do not),
  else the setting. Its `/models` does not say, so no request is made for this.
- **OpenRouter**: the model list's `architecture.input_modalities`, else the setting.
- **Gemini**: Gemini 1.5 and later (and the `-latest` aliases), not 1.0; others (Gemma)
  the setting.
- **Ollama, LM Studio**: the setting.

The setting is **This model can see images** in Settings → the connection's panel
(`connections.setVision`), saved per connection as `connections[].vision` in
settings.json, **off by default**. It only decides when nothing above says; where the
model list does say, Settings shows that instead of the switch. Claude and Codex do not
offer it.

A model that cannot see images never gets one: `createAgent({ vision: false })` (the
default) replaces every image block in the request with a note, tool images are never
attached, and the model reads `[N images omitted (page 1, …). This model cannot see
images. Switch to a vision-capable model to show them.]` with the tool's text. Attached
images become `[Attached image (user-provided, untrusted): name, image, size — not sent.
This model cannot see images. …]`, and their bytes are not read.

## Budget

`IMAGE_BUDGET`: tool images are resent only from the last **2 tool steps** of the run, at
most **20 images** per request, newest first (tool images and attached images together).
An older tool step is read as its saved note, which says the agent can call the tool
again to see the images; an image over the cap becomes a note saying it was not resent.
Only the newest 20 image attachments of a chat are read from the store at all.

Claude Code and Codex keep every image of a reply in their own context, so for them the
20 images are spent per reply: the transcript's images first, then tool images until
none are left (the tool's text then says how many were held back). The 2-step rule
cannot be applied inside those runtimes.

## Saved chats

Images are never saved with a chat:

- a tool result is saved as its text plus a note naming its images (`[2 images shown with
this result (page 1, page 2). Images are not kept in the conversation; call the tool
again to see them.]`). Its bytes live only in the running agent loop, for the 2-step
  budget, and are dropped when the run ends. On reload the model reads the note; the
  chat format is unchanged (tool results are still text), so older chats load as before
  and older app versions read newer chats;
- an attached image is saved as its attachment reference, as before; its bytes stay in the
  attachment store and are read again for each request (and each fork, retry or reload).

## Checks

- Bytes come only from a tool's result or the attachment store, never from a path or
  URL in a message.
- Tool images must be PNG or JPEG whose magic bytes match `mime` and whose header
  dimensions match `width`/`height`; attached images must be the format the store
  recorded (PNG, JPEG, WebP, GIF). Every image is at most 5 MB encoded. Anything else is
  dropped with a note.
- Labels are plain words of at most 60 characters (`page 3`). Anything with a slash,
  colon, control or bidi character, or a long unbroken run (a token, a hash) becomes
  `image N`, so no path or secret reaches a model through a label.
- Attached images keep the untrusted-data introduction; tool images in a separate
  message (Chat Completions, ChatGPT fallback, Gemini before 3) are introduced as tool
  output, not the user's words.

## Tests

`agent/images.test.ts` (checks, labels, budget), `agent/agent.test.ts` (the loop: sent
with vision, budget across steps, saved notes, none without vision), the clients against
fake servers (`openai-compat/client.test.ts`, `openai-responses/client.test.ts` including
the fallback, `gemini/translate.test.ts`), `chat/attachments-images.test.ts` (attachments
through each client's wire format), `providers/claude.test.ts` and `codex.test.ts`
(runtime formats, Codex text-only models), `providers/adapters/new-connections.test.ts`
and `vision.test.ts` (who sees images, the setting), and the renderer's chip and Settings
tests.

## Checked live only

These need a real account and are not covered by CI:

1. **ChatGPT · Plan tool images.** Sign in with a Plus or Pro plan, choose a GPT-5 model,
   grant a folder with a PNG, and have a tool return an image (once `read_document`
   lands: "read page 1 of scan.pdf as an image"). Check the reply describes the page. In
   the main-process log, see whether a `chatgpt-plan` request was refused and retried
   (the fallback); either way the reply must describe the image. Also attach a PNG and
   ask what it shows.
2. **Claude subscription image accounting.** With Claude Pro/Max, attach two images and
   ask about both; then run a tool that returns several images. Check both are described
   and that the usage panel/plan limits move as for a normal reply (images are counted
   by Claude, not by the app), and that a run with more than 20 images says the rest were
   held back.
3. **Older Gemini.** With a Gemini key, choose `gemini-2.5-flash` and have a tool return
   an image; the reply must describe it (images after the function response). Repeat
   with a Gemini 3 model (images inside the function response). Choose a Gemma model:
   no image is sent until "This model can see images" is turned on.
4. **Codex.** Sign in with ChatGPT, attach a PNG and ask what it shows; then a tool image.
5. **Local servers.** With Ollama running `llava` (or LM Studio with a VLM), turn on "This
   model can see images", attach a PNG; with the setting off, the chip is grey and the
   model is told it cannot see images.
