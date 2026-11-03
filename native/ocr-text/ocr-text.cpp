// ocr-text.exe: recognises the text in one image with Windows' built-in OCR
// (Windows.Media.Ocr). The app bundles no OCR engine or language data: the recognizer and
// its languages are part of Windows (Settings > Time & language > Language & region).
//
//   ocr-text.exe --probe
//   ocr-text.exe --recognize --input-bytes <n> --max-memory <bytes>
//                [--lang auto|<bcp47>] [--max-output <bytes>]
//
// The image is untrusted, so before reading a byte of it (and before RoInitialize) the
// process locks itself down exactly as heif-decode.exe does:
// - it joins a Job Object of its own that allows no other process, caps its memory
//   (--max-memory, 64 to 256 MiB) and CPU time (60 s), kills it on an unhandled exception,
//   and denies desktop, clipboard, global atoms and other processes' USER handles;
// - it lowers its token to Low integrity;
// - it turns on mitigations: no extension points, no remote or Low-labelled DLLs, System32
//   first, no non-system fonts, strict handle checks; DLLs load from System32 only.
// If any of that fails, it recognises nothing. There is no switch to relax any of it.
//
// Input (stdin, --recognize): raw pixels, so no image decoder ever sees untrusted bytes.
//   offset 0  4 bytes  "OCRP"
//          4  1 byte   version, 1
//          5  1 byte   format: 1 = BGRA8 (4 bytes per pixel), 2 = Gray8 (1 byte per pixel)
//          6  2 bytes  0
//          8  4 bytes  width, little-endian, 1..4096
//         12  4 bytes  height, little-endian, 1..4096
//         16           width * height * bytes-per-pixel bytes, rows top to bottom, no padding
// The header is read and checked first: its size must equal --input-bytes (what the
// caller said it would send) before anything is allocated, and exactly that many bytes
// must follow, then end of input.
//
// Language: --lang auto (the default) is the first of the user's profile languages that
// has OCR installed; --lang <tag> asks for that one.
//
// stdout (--recognize): one JSON object of at most --max-output bytes (default and most
// 1 MiB). Lines that would pass it are dropped, whole, and "truncated" is true:
//   {"v":1,"lang":"en-US","angle":0.5|null,"width":W,"height":H,
//    "lines":[{"box":[x,y,w,h],"text":"..."}],"truncated":false}
// Boxes are in input pixels. stdout (--probe):
//   {"v":1,"languages":["en-US",...],"user":"en-US"|null,"max_dimension":10000}
//
// stderr: exactly one report line, then exit:
//   ocr-text:1 probe languages=<n> user=<0|1>                              exit 0
//   ocr-text:1 ok lines=<n> chars=<n> width=<px> height=<px> ms=<n> peak=<bytes>  exit 0
//   ocr-text:1 error=<step> code=<0xHRESULT>                               exit 1
//   ocr-text:1 error=no-language|language-not-installed code=<0xHRESULT>   exit 2
//   ocr-text:1 error=<step> code=<0xHRESULT>  (possibly out of memory)     exit 3
// Recognition fails with E_UNEXPECTED, not E_OUTOFMEMORY, when the job's memory limit is
// hit (measured in the spike, PR #72), so that is reported as exit 3 too.

#define _CRT_SECURE_NO_WARNINGS
#include <windows.h>
#include <psapi.h>

#include <math.h>
#include <stdio.h>
#include <string.h>
#include <wchar.h>

#include <new>
#include <string>

#include <winrt/base.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.Globalization.h>
#include <winrt/Windows.Graphics.Imaging.h>
#include <winrt/Windows.Media.Ocr.h>
#include <winrt/Windows.Storage.Streams.h>

using namespace winrt;
using namespace winrt::Windows::Graphics::Imaging;
using namespace winrt::Windows::Media::Ocr;
using namespace winrt::Windows::Storage::Streams;

#define CPU_SECONDS 60
#define MIN_MEMORY (64ull * 1024 * 1024)
#define MAX_MEMORY (256ull * 1024 * 1024)
#define PROBE_MEMORY (128ull * 1024 * 1024)
#define MAX_EDGE 4096u
#define HEADER_BYTES 16u
#define MIN_OUTPUT 1024ull
#define MAX_OUTPUT (1024ull * 1024)
#define MAX_TAG 85

enum { EXIT_OK = 0, EXIT_FAILED = 1, EXIT_NO_LANGUAGE = 2, EXIT_MEMORY = 3 };

static const char *g_step = "start";

static void report(const char *line) {
  DWORD written;
  HANDLE err = GetStdHandle(STD_ERROR_HANDLE);
  if (err != INVALID_HANDLE_VALUE && err != NULL)
    WriteFile(err, line, (DWORD)strlen(line), &written, NULL);
}

static __declspec(noreturn) void fail_with(const char *step, HRESULT hr, UINT exit_code) {
  char line[128];
  _snprintf(line, sizeof line - 1, "ocr-text:1 error=%s code=0x%08lX\n", step,
            (unsigned long)hr);
  line[sizeof line - 1] = '\0';
  report(line);
  ExitProcess(exit_code);
}

static bool out_of_memory(HRESULT hr) {
  return hr == E_OUTOFMEMORY || hr == HRESULT_FROM_WIN32(ERROR_NOT_ENOUGH_MEMORY) ||
         hr == HRESULT_FROM_WIN32(ERROR_COMMITMENT_LIMIT);
}

static __declspec(noreturn) void fail(const char *step, HRESULT hr) {
  fail_with(step, hr, out_of_memory(hr) ? EXIT_MEMORY : EXIT_FAILED);
}

static HRESULT last_error(void) { return HRESULT_FROM_WIN32(GetLastError()); }

static int parse_u64(const wchar_t *text, unsigned long long *out) {
  wchar_t *end;
  if (!text || *text < L'0' || *text > L'9') return 0;
  *out = _wcstoui64(text, &end, 10);
  return *end == L'\0' && *out != _UI64_MAX;
}

// The same lockdown as heif-decode.c's lock_down; keep the two in step.
static void lock_down(unsigned long long max_memory) {
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
  JOBOBJECT_BASIC_UI_RESTRICTIONS ui;
  PROCESS_MITIGATION_EXTENSION_POINT_DISABLE_POLICY extension;
  PROCESS_MITIGATION_IMAGE_LOAD_POLICY image;
  PROCESS_MITIGATION_FONT_DISABLE_POLICY font;
  PROCESS_MITIGATION_STRICT_HANDLE_CHECK_POLICY handles;
  BYTE sid[SECURITY_MAX_SID_SIZE];
  DWORD sid_size = sizeof sid;
  TOKEN_MANDATORY_LABEL label;
  HANDLE token = NULL;
  HANDLE job;

  g_step = "lockdown";
  SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
  if (!SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32)) fail("dll-directories", last_error());

  // The job's only handle stays open in this process and is never inherited.
  job = CreateJobObjectW(NULL, NULL);
  if (!job) fail("job", last_error());
  ZeroMemory(&limits, sizeof limits);
  limits.BasicLimitInformation.LimitFlags =
      JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION |
      JOB_OBJECT_LIMIT_ACTIVE_PROCESS | JOB_OBJECT_LIMIT_PROCESS_MEMORY |
      JOB_OBJECT_LIMIT_PROCESS_TIME;
  limits.BasicLimitInformation.ActiveProcessLimit = 1;
  limits.BasicLimitInformation.PerProcessUserTimeLimit.QuadPart = CPU_SECONDS * 10000000ll;
  limits.ProcessMemoryLimit = (SIZE_T)max_memory;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof limits))
    fail("job-limits", last_error());
  ui.UIRestrictionsClass = JOB_OBJECT_UILIMIT_DESKTOP | JOB_OBJECT_UILIMIT_DISPLAYSETTINGS |
                           JOB_OBJECT_UILIMIT_EXITWINDOWS | JOB_OBJECT_UILIMIT_GLOBALATOMS |
                           JOB_OBJECT_UILIMIT_HANDLES | JOB_OBJECT_UILIMIT_READCLIPBOARD |
                           JOB_OBJECT_UILIMIT_SYSTEMPARAMETERS | JOB_OBJECT_UILIMIT_WRITECLIPBOARD;
  if (!SetInformationJobObject(job, JobObjectBasicUIRestrictions, &ui, sizeof ui))
    fail("job-ui", last_error());
  if (!AssignProcessToJobObject(job, GetCurrentProcess())) fail("job-assign", last_error());

  ZeroMemory(&extension, sizeof extension);
  extension.DisableExtensionPoints = 1;
  if (!SetProcessMitigationPolicy(ProcessExtensionPointDisablePolicy, &extension, sizeof extension))
    fail("mitigation-extension-points", last_error());
  ZeroMemory(&image, sizeof image);
  image.NoRemoteImages = 1;
  image.NoLowMandatoryLabelImages = 1;
  image.PreferSystem32Images = 1;
  if (!SetProcessMitigationPolicy(ProcessImageLoadPolicy, &image, sizeof image))
    fail("mitigation-image-load", last_error());
  ZeroMemory(&font, sizeof font);
  font.DisableNonSystemFonts = 1;
  if (!SetProcessMitigationPolicy(ProcessFontDisablePolicy, &font, sizeof font))
    fail("mitigation-fonts", last_error());
  ZeroMemory(&handles, sizeof handles);
  handles.RaiseExceptionOnInvalidHandleReference = 1;
  handles.HandleExceptionsPermanentlyEnabled = 1;
  if (!SetProcessMitigationPolicy(ProcessStrictHandleCheckPolicy, &handles, sizeof handles))
    fail("mitigation-handles", last_error());

  // Low integrity: no writing up to the user's (Medium) files, keys or processes.
  if (!CreateWellKnownSid(WinLowLabelSid, NULL, sid, &sid_size)) fail("low-sid", last_error());
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_ADJUST_DEFAULT | TOKEN_QUERY, &token))
    fail("token", last_error());
  label.Label.Attributes = SE_GROUP_INTEGRITY;
  label.Label.Sid = (PSID)sid;
  if (!SetTokenInformation(token, TokenIntegrityLevel, &label,
                           (DWORD)(sizeof label + GetLengthSid((PSID)sid))))
    fail("low-integrity", last_error());
  CloseHandle(token);
}

static std::string utf8(const wchar_t *text, size_t length) {
  if (length == 0 || length > 0x7fffffff) return std::string();
  int n = WideCharToMultiByte(CP_UTF8, 0, text, (int)length, NULL, 0, NULL, NULL);
  if (n <= 0) return std::string();
  std::string s((size_t)n, '\0');
  WideCharToMultiByte(CP_UTF8, 0, text, (int)length, &s[0], n, NULL, NULL);
  return s;
}

/** A JSON string (quoted, escaped) of `text`, at most `max_chars` UTF-16 units of it. */
static std::string json_string(const hstring &text, size_t max_chars = (size_t)-1) {
  size_t length = text.size() < max_chars ? text.size() : max_chars;
  std::string raw = utf8(text.c_str(), length);
  std::string s = "\"";
  for (unsigned char c : raw) {
    if (c == '"') s += "\\\"";
    else if (c == '\\') s += "\\\\";
    else if (c < 0x20 || c == 0x7f) {
      char esc[8];
      _snprintf(esc, sizeof esc, "\\u%04x", c);
      s += esc;
    } else s += (char)c;
  }
  return s + "\"";
}

static void write_stdout(const std::string &text) {
  HANDLE out = GetStdHandle(STD_OUTPUT_HANDLE);
  const char *bytes = text.data();
  size_t size = text.size();
  if (out == INVALID_HANDLE_VALUE || out == NULL) fail("output", E_HANDLE);
  while (size > 0) {
    DWORD written = 0;
    if (!WriteFile(out, bytes, (DWORD)size, &written, NULL) || written == 0)
      fail("output", last_error());
    bytes += written;
    size -= written;
  }
}

static __declspec(noreturn) void probe(void) {
  lock_down(PROBE_MEMORY);
  g_step = "ro-initialize";
  init_apartment(apartment_type::multi_threaded);
  g_step = "languages";
  std::string s = "{\"v\":1,\"languages\":[";
  unsigned count = 0;
  for (auto const &language : OcrEngine::AvailableRecognizerLanguages()) {
    if (count >= 256) break;
    if (count) s += ",";
    s += json_string(language.LanguageTag(), MAX_TAG);
    count++;
  }
  g_step = "user-profile-engine";
  OcrEngine engine = OcrEngine::TryCreateFromUserProfileLanguages();
  s += "],\"user\":";
  s += engine ? json_string(engine.RecognizerLanguage().LanguageTag(), MAX_TAG) : "null";
  char buf[64];
  _snprintf(buf, sizeof buf, ",\"max_dimension\":%u}\n", OcrEngine::MaxImageDimension());
  s += buf;
  write_stdout(s);
  _snprintf(buf, sizeof buf, "ocr-text:1 probe languages=%u user=%d\n", count, engine ? 1 : 0);
  report(buf);
  ExitProcess(EXIT_OK);
}

/** Reads exactly `size` bytes of stdin into `into`; false at end of input before that. */
static bool read_exact(HANDLE in, BYTE *into, size_t size) {
  while (size > 0) {
    DWORD got = 0;
    DWORD want = size > 0x10000000 ? 0x10000000 : (DWORD)size;
    if (!ReadFile(in, into, want, &got, NULL)) {
      if (GetLastError() == ERROR_BROKEN_PIPE) return false;
      fail("input", last_error());
    }
    if (got == 0) return false;
    into += got;
    size -= got;
  }
  return true;
}

static UINT32 le32(const BYTE *p) {
  return (UINT32)p[0] | ((UINT32)p[1] << 8) | ((UINT32)p[2] << 16) | ((UINT32)p[3] << 24);
}

struct Image {
  UINT32 width = 0;
  UINT32 height = 0;
  BitmapPixelFormat format = BitmapPixelFormat::Bgra8;
};

/**
 * Reads and checks the header, then the pixels into a buffer of exactly the size the
 * header implies, which must match what the caller said (`input_bytes`); then end of
 * input. Nothing is allocated for pixels before the header passes.
 */
static Buffer read_image(unsigned long long input_bytes, Image *image) {
  HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
  BYTE header[HEADER_BYTES];
  if (in == INVALID_HANDLE_VALUE || in == NULL) fail("input", E_HANDLE);
  g_step = "header";
  if (!read_exact(in, header, sizeof header)) fail("input-truncated", E_INVALIDARG);
  if (memcmp(header, "OCRP", 4) != 0 || header[4] != 1 || header[6] != 0 || header[7] != 0)
    fail("bad-header", E_INVALIDARG);
  unsigned bytes_per_pixel = 0;
  if (header[5] == 1) {
    image->format = BitmapPixelFormat::Bgra8;
    bytes_per_pixel = 4;
  } else if (header[5] == 2) {
    image->format = BitmapPixelFormat::Gray8;
    bytes_per_pixel = 1;
  } else {
    fail("bad-format", E_INVALIDARG);
  }
  image->width = le32(header + 8);
  image->height = le32(header + 12);
  if (image->width == 0 || image->height == 0) fail("bad-header", E_INVALIDARG);
  if (image->width > MAX_EDGE || image->height > MAX_EDGE ||
      image->width > OcrEngine::MaxImageDimension() ||
      image->height > OcrEngine::MaxImageDimension())
    fail("too-large", E_INVALIDARG);
  // At most 4096 * 4096 * 4 = 64 MiB: no overflow.
  unsigned long long pixels = (unsigned long long)image->width * image->height * bytes_per_pixel;
  if (pixels + HEADER_BYTES != input_bytes) fail("size-mismatch", E_INVALIDARG);

  g_step = "buffer";
  Buffer buffer((uint32_t)pixels);
  if (!read_exact(in, buffer.data(), (size_t)pixels)) fail("input-truncated", E_INVALIDARG);
  buffer.Length((uint32_t)pixels);
  BYTE extra;
  if (read_exact(in, &extra, 1)) fail("input-too-large", E_INVALIDARG);
  return buffer;
}

struct Options {
  std::wstring lang = L"auto";
  unsigned long long input_bytes = 0;
  unsigned long long max_memory = 0;
  unsigned long long max_output = MAX_OUTPUT;
};

static double now_ms(void) {
  static LARGE_INTEGER freq;
  LARGE_INTEGER t;
  if (!freq.QuadPart) QueryPerformanceFrequency(&freq);
  QueryPerformanceCounter(&t);
  return (double)t.QuadPart * 1000.0 / (double)freq.QuadPart;
}

static long clamp_px(double value, UINT32 limit) {
  if (!(value > 0)) return 0;  // also NaN
  if (value > (double)limit) return (long)limit;
  return (long)value;
}

static __declspec(noreturn) void recognize(Options const &o) {
  lock_down(o.max_memory);

  g_step = "ro-initialize";
  init_apartment(apartment_type::multi_threaded);

  // The engine first: with no OCR language there is no point reading the image.
  g_step = "engine";
  OcrEngine engine{nullptr};
  if (o.lang == L"auto") {
    engine = OcrEngine::TryCreateFromUserProfileLanguages();
    if (!engine) fail_with("no-language", E_NOTIMPL, EXIT_NO_LANGUAGE);
  } else {
    winrt::Windows::Globalization::Language language{hstring(o.lang)};
    if (!OcrEngine::IsLanguageSupported(language))
      fail_with("language-not-installed", E_NOTIMPL, EXIT_NO_LANGUAGE);
    engine = OcrEngine::TryCreateFromLanguage(language);
    if (!engine) fail_with("language-not-installed", E_NOTIMPL, EXIT_NO_LANGUAGE);
  }

  Image image;
  SoftwareBitmap bitmap{nullptr};
  {
    Buffer pixels = read_image(o.input_bytes, &image);
    g_step = "bitmap";
    bitmap = SoftwareBitmap::CreateCopyFromBuffer(
        pixels, image.format, (int32_t)image.width, (int32_t)image.height,
        // As the spike passed BGRA (opaque pixels read the same either way); Gray8 has no alpha.
        image.format == BitmapPixelFormat::Bgra8 ? BitmapAlphaMode::Premultiplied
                                                 : BitmapAlphaMode::Ignore);
  }  // The input buffer is released here, before recognition.

  g_step = "recognize";
  double t0 = now_ms();
  OcrResult result{nullptr};
  try {
    result = engine.RecognizeAsync(bitmap).get();
  } catch (hresult_error const &e) {
    // The job's memory limit shows up here as E_UNEXPECTED.
    HRESULT hr = e.code();
    fail_with("recognize", hr,
              hr == E_UNEXPECTED || out_of_memory(hr) ? EXIT_MEMORY : EXIT_FAILED);
  }
  double elapsed = now_ms() - t0;

  g_step = "output";
  char buf[160];
  std::string out = "{\"v\":1,\"lang\":";
  out += json_string(engine.RecognizerLanguage().LanguageTag(), MAX_TAG);
  auto angle = result.TextAngle();
  if (angle && isfinite(angle.Value()) && fabs(angle.Value()) <= 360.0)
    _snprintf(buf, sizeof buf, ",\"angle\":%.3f", angle.Value());
  else
    _snprintf(buf, sizeof buf, ",\"angle\":null");
  out += buf;
  _snprintf(buf, sizeof buf, ",\"width\":%u,\"height\":%u,\"lines\":[", image.width,
            image.height);
  out += buf;
  // Room for the closing `],"truncated":false}\n`.
  const size_t cap = (size_t)o.max_output - 32;
  bool truncated = false;
  unsigned lines = 0;
  size_t chars = 0;
  for (auto const &line : result.Lines()) {
    double x0 = 1e30, y0 = 1e30, x1 = -1e30, y1 = -1e30;
    for (auto const &word : line.Words()) {
      auto r = word.BoundingRect();
      if (r.X < x0) x0 = r.X;
      if (r.Y < y0) y0 = r.Y;
      if (r.X + r.Width > x1) x1 = r.X + r.Width;
      if (r.Y + r.Height > y1) y1 = r.Y + r.Height;
    }
    long left = 0, top = 0, right = 0, bottom = 0;
    if (x1 >= x0 && y1 >= y0) {
      left = clamp_px(floor(x0), image.width);
      top = clamp_px(floor(y0), image.height);
      right = clamp_px(ceil(x1), image.width);
      bottom = clamp_px(ceil(y1), image.height);
    }
    hstring text = line.Text();
    std::string item = lines ? "," : "";
    _snprintf(buf, sizeof buf, "{\"box\":[%ld,%ld,%ld,%ld],\"text\":", left, top, right - left,
              bottom - top);
    item += buf;
    item += json_string(text);
    item += "}";
    if (out.size() + item.size() > cap) {
      truncated = true;
      break;
    }
    out += item;
    lines++;
    chars += text.size();
  }
  out += "],\"truncated\":";
  out += truncated ? "true" : "false";
  out += "}\n";
  write_stdout(out);

  PROCESS_MEMORY_COUNTERS memory;
  ZeroMemory(&memory, sizeof memory);
  memory.cb = sizeof memory;
  GetProcessMemoryInfo(GetCurrentProcess(), &memory, sizeof memory);
  char line[192];
  _snprintf(line, sizeof line - 1,
            "ocr-text:1 ok lines=%u chars=%zu width=%u height=%u ms=%lu peak=%zu\n", lines,
            chars, image.width, image.height, (unsigned long)(elapsed + 0.5),
            (size_t)memory.PeakPagefileUsage);
  line[sizeof line - 1] = '\0';
  report(line);
  ExitProcess(EXIT_OK);
}

static bool valid_tag(const wchar_t *tag) {
  size_t n = wcslen(tag);
  if (n == 0 || n > 35) return false;
  for (size_t i = 0; i < n; i++) {
    wchar_t c = tag[i];
    if (!((c >= L'a' && c <= L'z') || (c >= L'A' && c <= L'Z') || (c >= L'0' && c <= L'9') ||
          c == L'-'))
      return false;
  }
  return true;
}

static __declspec(noreturn) void run(int argc, wchar_t **argv) {
  if (argc == 2 && wcscmp(argv[1], L"--probe") == 0) probe();
  if (argc < 2 || wcscmp(argv[1], L"--recognize") != 0) fail("usage", E_INVALIDARG);
  Options o;
  int i;
  for (i = 2; i + 1 < argc; i += 2) {
    const wchar_t *name = argv[i];
    const wchar_t *value = argv[i + 1];
    if (wcscmp(name, L"--lang") == 0) {
      if (wcscmp(value, L"auto") != 0 && !valid_tag(value)) fail("usage", E_INVALIDARG);
      o.lang = value;
    } else if (wcscmp(name, L"--input-bytes") == 0) {
      if (!parse_u64(value, &o.input_bytes)) fail("usage", E_INVALIDARG);
    } else if (wcscmp(name, L"--max-memory") == 0) {
      if (!parse_u64(value, &o.max_memory)) fail("usage", E_INVALIDARG);
    } else if (wcscmp(name, L"--max-output") == 0) {
      if (!parse_u64(value, &o.max_output)) fail("usage", E_INVALIDARG);
    } else {
      fail("usage", E_INVALIDARG);
    }
  }
  if (i != argc || o.input_bytes <= HEADER_BYTES ||
      o.input_bytes > HEADER_BYTES + 4ull * MAX_EDGE * MAX_EDGE || o.max_memory < MIN_MEMORY ||
      o.max_memory > MAX_MEMORY || o.max_output < MIN_OUTPUT || o.max_output > MAX_OUTPUT)
    fail("usage", E_INVALIDARG);
  recognize(o);
}

int wmain(int argc, wchar_t **argv) {
  try {
    run(argc, argv);
  } catch (hresult_error const &e) {
    fail(g_step, e.code());
  } catch (std::bad_alloc const &) {
    fail(g_step, E_OUTOFMEMORY);
  } catch (...) {
    fail(g_step, E_UNEXPECTED);
  }
}
