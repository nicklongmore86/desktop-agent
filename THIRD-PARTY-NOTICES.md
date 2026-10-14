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
