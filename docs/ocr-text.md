# ocr-text.exe: Windows OCR, outside the app

`resources\helpers\ocr-text.exe` (source: `native/ocr-text/ocr-text.cpp`) recognises the text in one image with Windows' built-in OCR, `Windows.Media.Ocr`. The app bundles no OCR engine and no language data. The recognizer and its languages are part of Windows: each language's "Optical character recognition" feature, under Settings › Time & language › Language & region.

The main-process side is `src/main/documents/system-ocr.ts`. `search_files` calls `recognize()` for scanned PDF pages (see [document-reader.md](document-reader.md#ocr-of-scanned-pages)), and `probe()` once per search that finds such pages. Photos are not read by OCR. The app creates the launcher at start without running anything and, on quit, cancels anything it has running.

The design was measured in the spike, draft PR #72. Windows OCR works under heif-decode.exe's full lockdown with nothing relaxed. It reads about 2 to 4 pages a second, has a character error rate under 0.5% on clean and scanned-looking text pages, needs roughly 20 MiB + 12 bytes per pixel, and cannot read pages rotated by 90°.

## Interface

```
ocr-text.exe --probe
ocr-text.exe --recognize --input-bytes <n> --max-memory <bytes> [--lang auto|<bcp47>] [--max-output <bytes>]
```

**Input** (`--recognize`, on stdin) is raw pixels, never an image file, so the untrusted bytes never reach an image decoder:

| Offset | Size | Field                                                               |
| ------ | ---- | ------------------------------------------------------------------- |
| 0      | 4    | `OCRP`                                                              |
| 4      | 1    | version, `1`                                                        |
| 5      | 1    | format: `1` BGRA8 (4 bytes per pixel), `2` Gray8 (1 byte per pixel) |
| 6      | 2    | `0`                                                                 |
| 8      | 4    | width, little-endian, 1 to 4096                                     |
| 12     | 4    | height, little-endian, 1 to 4096                                    |
| 16     | …    | `width × height × bytes per pixel`, rows top to bottom, no padding  |

The helper reads and checks the 16-byte header first. The size it implies must equal `--input-bytes`, the size the caller said it would send. Only then does the helper allocate a buffer of exactly that size. Exactly that many bytes must follow, then end of input. Anything else is refused with its own step: `bad-header`, `bad-format`, `too-large`, `size-mismatch`, `input-truncated` or `input-too-large`.

**Language**: `auto`, the default, uses the first of the user's Windows profile languages that has OCR installed (`OcrEngine.TryCreateFromUserProfileLanguages`). `--lang <tag>` asks for one language. The helper creates the engine before it reads the image.

**Output** is a single JSON object on stdout, at most `--max-output` bytes (1 KiB to 1 MiB, default 1 MiB). Whole lines that would go past the cap are dropped, and `truncated` is set to true.

```json
{
  "v": 1,
  "lang": "en-US",
  "angle": 0.5,
  "width": 2200,
  "height": 1000,
  "lines": [{ "box": [80, 78, 1630, 47], "text": "The quick brown fox jumps over the lazy dog" }],
  "truncated": false
}
```

Boxes are `[x, y, width, height]` in input pixels: the union of the line's word boxes, clamped to the image. `angle` is Windows' detected text skew, or `null`. The probe writes `{"v":1,"languages":["en-US"],"user":"en-US"|null,"max_dimension":10000}`.

**Report**: exactly one line on stderr, then the exit code:

| Line                                                                           | Exit |
| ------------------------------------------------------------------------------ | ---- |
| `ocr-text:1 probe languages=<n> user=<0\|1>`                                   | 0    |
| `ocr-text:1 ok lines=<n> chars=<n> width=<px> height=<px> ms=<n> peak=<bytes>` | 0    |
| `ocr-text:1 error=<step> code=<0xHRESULT>`                                     | 1    |
| `ocr-text:1 error=no-language\|language-not-installed code=…`                  | 2    |
| `ocr-text:1 error=<step> code=…` (possibly out of memory)                      | 3    |

In the `ok` line, `lines` and `chars` describe the JSON as written: the number of lines emitted (after any truncation) and the total length of their `text` in UTF-16 code units (`hstring::size()`, the same as JavaScript's `string.length`, so an astral character counts 2). Lone surrogates are written as U+FFFD, still one unit. Main refuses output whose JSON does not match the report.

Exit 3 covers `E_OUTOFMEMORY` and, at the `recognize` step, `E_UNEXPECTED`. When the Job Object's memory limit is hit during recognition, Windows OCR fails with `E_UNEXPECTED`, not an out-of-memory error (measured in PR #72).

## Security model

The image comes from a file the agent was allowed to read, so it is untrusted. The app's main process decodes nothing. The document worker renders PDF pages to raw pixels for `recognize()`.

- **Lockdown before input.** Before RoInitialize and before reading a byte of input, the helper applies the same lockdown as heif-decode.exe (`lock_down`, kept in step with `heif-decode.c`):
  - its own Job Object: one process, a memory limit, 60 s of CPU, killed on an unhandled exception, and no desktop, clipboard, global atoms or other processes' USER handles;
  - Low integrity;
  - mitigations: no extension points, no remote or Low-labelled images, System32 first, no non-system fonts, strict handle checks;
  - DLL search limited to System32.

  If any step fails, it recognises nothing and reports that step. The spike's `--relax` switch is gone, and nothing can turn any of this off.

- **No decoder in the untrusted path.** The input is a fixed header and raw pixels, bounds-checked before allocation. The pixels go straight into a `SoftwareBitmap` (`CreateCopyFromBuffer`), and the input buffer is freed before recognition.
- **Limits, all enforced by both sides:**
  - long edge 4096 px (under `OcrEngine.MaxImageDimension`, 10000);
  - input at most 16 + 4096 × 4096 × 4 bytes;
  - job memory 64 MiB + 16 bytes per pixel, capped at 256 MiB (the helper refuses anything outside 64 to 256 MiB);
  - 60 s of CPU, and 60 s wall clock by default (the caller can set its own: search allows 60 s per helper it runs at once);
  - output 1 MiB.
- **What main sends.** `encodeOcrInput` checks the width, height, format and pixel count, then sends a copy of the pixels behind the header. Main sends nothing else: no path and no file.
- **Verified before every use.** Before every probe and every recognition, the helper must be a regular file at exactly `resources\helpers\ocr-text.exe`, outside every granted folder, matching the SHA-256 compiled into the app (`verifyPinnedHelper`, the same check as [job-run.exe](job-run.md#integrity-and-fallback)). If the check fails, `probe()` reports `unavailable` with the reason, and `recognize()` rejects with `OcrError('unavailable')` without running anything. OCR has no fallback.
- **Output re-validated in main.** The output must:
  - be strict UTF-8 JSON, at most the cap, with exactly the expected fields;
  - carry a BCP 47 language tag and a finite angle (or `null`);
  - report the same width and height as the image that was sent;
  - give every box as non-negative integers inside the image;
  - have a line count and size that match the report line.

  Anything else is `OcrError('output')`. More than the cap on stdout kills the helper.

- **Cancellation.** `recognize(image, { signal })` and `cancelAll()` kill the process (`TerminateProcess`), which closes the job's only handle.

## Errors

`OcrError.code` is one of:

- `unsupported`: not Windows. Nothing is looked for or run.
- `unavailable`: the helper is missing, tampered with or could not start.
- `no-language`: no OCR language is installed, none of the user's languages has OCR, or the requested language is not installed.
- `invalid-image`: a bad image or bad options. The helper rejecting a header also lands here, because it means main encoded the image wrongly.
- `too-large`: over 4096 px on a side.
- `memory`: exit 3.
- `timeout`, `cancelled`: the deadline passed or the caller cancelled.
- `output`: the result did not check out, or there was too much of it.
- `failed`: any other failure, such as a crash, the CPU limit or a lockdown step.

`probe()` resolves `{ available: true, languages, userLanguage }` or `{ available: false, reason, message, languages }`, where `reason` is `unsupported`, `unavailable` or `no-language`. It never rejects. The answer is cached until `probe({ refresh: true })`.

## Build and packaging

`pnpm build:helpers` (`scripts/build-job-helper.mjs`) builds it as the third helper, beside job-run.exe and heif-decode.exe:

- **Compile:** C++20 with C++/WinRT from the Windows SDK, `cl /std:c++20 /permissive- /EHsc /bigobj /O1 /MT /GS /guard:cf /W4 /WX /Brepro`.
- **Link:** `kernel32.lib advapi32.lib windowsapp.lib` with the same hardened flags as the other helpers (`/DYNAMICBASE /HIGHENTROPYVA /NXCOMPAT /guard:cf /CETCOMPAT /DEPENDENTLOADFLAG:0x800`), plus a version resource (`native/ocr-text/ocr-text.rc`; keep its version in step with `OCR_TEXT_VERSION` in `scripts/job-helper.mjs`).
- **Pin:** the build fails unless the PE has ASLR, DEP and CFG. Its SHA-256 goes into `build/job-helper-pins.json`, and the main build compiles it in as the marker `ocr-text.exe-sha256:<digest>` (`__OCR_TEXT_PIN__`).
- **Package:** electron-builder copies it to `resources/helpers`. afterPack (`verifyHelpers`) fails the package unless the packaged file matches the pin and is hardened, and unless the production main bundle carries that same pin exactly once.

## Tests

- **Every platform:** `src/main/documents/system-ocr.test.ts` covers header encoding and limits, report parsing, the exit-code and step mapping, output re-validation, probe states and non-Windows `unsupported`. It also drives a fake helper through the real `runOcrHelper` to cover the deadline, cancellation, `cancelAll`, the output cap and a helper that cannot start. `scripts/job-helper.test.mjs` covers the third pin.
- **Windows:** `src/main/documents/ocr-text.test.ts` runs the real helper. In the Windows check job it runs as built; in the installer job it runs as packaged (`DESKTOP_TEST_RESOURCES`, `-t 'packaged ocr-text.exe'`). The cases are:
  - the pin and the probe;
  - a page of known Arial text rendered on the runner with System.Drawing;
  - the same page as Gray8;
  - a degraded page: 1.5° skew, low contrast, noise and speckle;
  - a 4096 × 2896 page;
  - a 4096 × 4096 page in BGRA and Gray8, within 256 MiB;
  - oversized, malformed and mismatched headers, plus usage errors (including the old `--relax`);
  - a language that is not installed (exit 2);
  - output truncated at a line boundary;
  - cancellation, `cancelAll` and the deadline;
  - a tampered copy that is refused.

  Each test logs the helper's recognition time and peak commit.

## Speed

Recognition alone, from PR #75's runs on GitHub's Windows runner: 120 to 160 ms for a 1568 x 2200 page, 230 to 370 ms at 4096 px, and about 450 ms for the first, cold run.

## Licences

- **Windows OCR** (`Windows.Media.Ocr`) and its language data are part of Windows, used through public WinRT APIs. Nothing from them is redistributed.
- **C++/WinRT** (`winrt/base.h` and the projection headers generated from the Windows SDK's metadata) is compiled into the binary. It is under the MIT License, copyright Microsoft Corporation; see [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md#cwinrt-ocr-textexe).
- **The MSVC static runtime** (`/MT`) is linked in, as it is for the other helpers.

## Limits

- **Unsigned**, like the other helpers. See [job-run.md](job-run.md#limits) for what the pin does and does not protect against within the same user.
- **Rotated pages.** Pages rotated by 90° read as nothing. The caller has to try other orientations if it wants them.
- **Drawings.** Text crossed by linework, circled labels and rotated labels read poorly (PR #72).
- **Large pages.** Pages over 4096 px must be scaled down by the caller first.
