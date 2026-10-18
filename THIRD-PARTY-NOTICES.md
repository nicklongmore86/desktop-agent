# Bundled runtimes

Desktop Agent preinstalls unmodified Claude Code 2.1.299 from the Claude Agent SDK
0.3.299 Windows x64 package, and the complete official Codex 0.162.1 Windows x64
release. Runtime versions follow app upgrades; independent CLI installations and
provider credentials are not replaced or removed by runtime packaging.

Codex is copyright OpenAI and licensed under Apache-2.0. Its LICENSE and NOTICE
are included beside this file. Additional component notices, licenses and source
references remain in the complete `runtimes/codex/codex-resources` release tree.
Source: https://github.com/openai/codex/tree/rust-v0.162.1

Claude Code and the Claude Agent SDK are copyright Anthropic PBC. All rights
reserved. Their original license notices are included beside this file. Use is
subject to https://code.claude.com/docs/en/legal-and-compliance and the applicable
Anthropic terms. Preinstallation is conditional on those terms and does not imply
endorsement or subscription integration approval.

The Claude distribution ambiguity described in README remains unresolved: the
support article describes Claude plan use with the SDK, while the SDK overview
requires prior approval for third-party products offering claude.ai login. This
package makes no authorization claim and does not change authentication methods.

# OpenAI Sign in with ChatGPT logo

The "Continue with ChatGPT" button in the ChatGPT · Plan sign-in screen shows OpenAI's
ChatGPT logo, taken unmodified from OpenAI's published Sign in with ChatGPT button assets
(`https://developers.openai.com/assets/siwc/sign-in-buttons/chatgpt-logo-white.svg`;
shipped as `src/renderer/src/assets/openai/chatgpt-logo-white.svg`, inside the app's
renderer bundle). It is drawn in white on the dark button and in black on the light
button from that one file.

The logo is OpenAI's trademark and artwork. It is **not** covered by this project's
Apache-2.0 license, nor by the Sign-in with ChatGPT DevKit Noncommercial License, which
excludes OpenAI's names, marks, logos and branded visual assets. Its use is subject to
OpenAI's Sign in with ChatGPT terms (https://openai.com/policies/sign-in-with-chatgpt-terms/)
and brand guidelines (https://openai.com/brand/), solely to identify the sign-in action.
Its use here does not imply OpenAI sponsors or endorses Desktop Agent. Do not reuse the
file outside that purpose, and follow OpenAI's current terms if you redistribute it.
