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

# Lucide icons

The sidebar's Settings gear, New chat and Archived icons come from Lucide, through the
`lucide-react` package (https://lucide.dev), which is bundled into the renderer. Its license
(from the package's LICENSE file; the package also carries the notice for the Feather
portions, MIT) is:

> ISC License
>
> Copyright (c) 2026 Lucide Icons and Contributors
>
> Permission to use, copy, modify, and/or distribute this software for any
> purpose with or without fee is hereby granted, provided that the above
> copyright notice and this permission notice appear in all copies.
>
> THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
> WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
> MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
> ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
> WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
> ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
> OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
>
> ---
>
> The following Lucide icons are derived from the Feather project:
>
> airplay, alert-circle, alert-octagon, alert-triangle, aperture, arrow-down-circle, arrow-down-left, arrow-down-right, arrow-down, arrow-left-circle, arrow-left, arrow-right-circle, arrow-right, arrow-up-circle, arrow-up-left, arrow-up-right, arrow-up, at-sign, calendar, cast, check, chevron-down, chevron-left, chevron-right, chevron-up, chevrons-down, chevrons-left, chevrons-right, chevrons-up, circle, clipboard, clock, code, columns, command, compass, corner-down-left, corner-down-right, corner-left-down, corner-left-up, corner-right-down, corner-right-up, corner-up-left, corner-up-right, crosshair, database, divide-circle, divide-square, dollar-sign, download, external-link, feather, frown, hash, headphones, help-circle, info, italic, key, layout, life-buoy, link-2, link, loader, lock, log-in, log-out, maximize, meh, minimize, minimize-2, minus-circle, minus-square, minus, monitor, moon, more-horizontal, more-vertical, move, music, navigation-2, navigation, octagon, pause-circle, percent, plus-circle, plus-square, plus, power, radio, rss, search, server, share, shopping-bag, sidebar, smartphone, smile, square, table-2, tablet, target, terminal, trash-2, trash, triangle, tv, type, upload, x-circle, x-octagon, x-square, x, zoom-in, zoom-out
>
> The MIT License (MIT) (for the icons listed above)
>
> Copyright (c) 2013-present Cole Bemis
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

# PDFium (document reader)

The document reader parses PDFs with PDFium compiled to WebAssembly, from the npm package
`@embedpdf/pdfium` 2.15.1 (https://github.com/embedpdf/embed-pdf-viewer/tree/main/packages/pdfium).
It is bundled, unmodified, into the app's `out/document-worker/` directory
(`assets/pdfium.wasm` and the JavaScript glue in `assets/index.js`) and runs only inside
the sandboxed document worker window.

- `@embedpdf/pdfium` wrapper and build: MIT License, copyright (c) 2024 CloudPDF, Ji Chang.
- PDFium: BSD 3-Clause License, copyright 2014 PDFium Authors; portions under the Apache
  License 2.0. Source: https://pdfium.googlesource.com/pdfium/
- Third-party libraries compiled into PDFium's WASM, under their own licenses (see
  `third_party/` in the PDFium source): FreeType (FreeType License), libjpeg-turbo
  (IJG and BSD 3-Clause), libpng (libpng License), zlib (zlib License), OpenJPEG
  (BSD 2-Clause), Little CMS (MIT) and Anti-Grain Geometry (BSD-style AGG license).

The package's `LICENSE` and PDFium's `LICENSE` (BSD 3-Clause and Apache 2.0 text) ship
beside the worker as `out/document-worker/licenses/embedpdf-pdfium-LICENSE.txt` and
`out/document-worker/licenses/pdfium-LICENSE.txt`.
