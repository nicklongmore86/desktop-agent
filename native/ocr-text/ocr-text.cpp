// ocr-text.exe (SPIKE, not wired into the app): recognises text in one PNG with Windows'
// built-in OCR (Windows.Media.Ocr) inside the same lockdown as heif-decode.exe, to find out
// whether WinRT activation works at Low integrity inside a Job Object.
//
//   ocr-text.exe --probe [--relax <list>]
//   ocr-text.exe --recognize [--lang auto|<bcp47>] [--decoder wic|winrt] [--repeat <n>]
//                [--max-input <bytes>] [--max-pixels <n>] [--max-memory <bytes>]
//                [--max-output <bytes>] [--relax <list>]
//
// --relax turns parts of the lockdown off, to find the minimal relaxation if the full
// lockdown breaks OCR: a comma list of job (no Job Object at all), ui (job without UI
// restrictions), low (stay at the caller's integrity), mitigations, dlldirs. The real
// helper would have no such switch.
//
// The lockdown is applied before a byte of input is read and before RoInitialize.
//
// stdout: one JSON object (at most --max-output bytes; lines past that are dropped and
// "truncated" is true). stderr, last line:
//   ocr-text:1 ok lang=<tag> lines=<n> chars=<n> width=<px> height=<px> scale=<f>
//     decode_ms=<f> engine_ms=<f> ocr_ms=<f> ocr_warm_ms=<f> peak_commit=<bytes>
//     peak_ws=<bytes> integrity=<rid> in_job=<0|1>
//   ocr-text:1 error=<step> code=<0xHRESULT>

#define _CRT_SECURE_NO_WARNINGS
#include <windows.h>
#include <psapi.h>
#include <wincodec.h>

#include <stdio.h>
#include <string.h>
#include <wchar.h>

#include <string>
#include <vector>

#include <winrt/base.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.Globalization.h>
#include <winrt/Windows.Graphics.Imaging.h>
#include <winrt/Windows.Media.Ocr.h>
#include <winrt/Windows.Storage.Streams.h>
#include <winrt/Windows.System.UserProfile.h>

using namespace winrt;
using namespace winrt::Windows::Graphics::Imaging;
using namespace winrt::Windows::Media::Ocr;
using namespace winrt::Windows::Storage::Streams;

#define CPU_SECONDS 60
#define MIN_MEMORY (64ull * 1024 * 1024)

enum {
  RELAX_JOB = 1,
  RELAX_UI = 2,
  RELAX_LOW = 4,
  RELAX_MITIGATIONS = 8,
  RELAX_DLLDIRS = 16,
};

static const char *g_step = "start";

static void report(const char *line) {
  DWORD written;
  HANDLE err = GetStdHandle(STD_ERROR_HANDLE);
  if (err != INVALID_HANDLE_VALUE && err != NULL)
    WriteFile(err, line, (DWORD)strlen(line), &written, NULL);
}

static __declspec(noreturn) void fail(const char *step, HRESULT hr) {
  char line[160];
  _snprintf(line, sizeof line - 1, "ocr-text:1 error=%s code=0x%08lX\n", step,
            (unsigned long)hr);
  line[sizeof line - 1] = '\0';
  report(line);
  ExitProcess(1);
}

static HRESULT last_error(void) { return HRESULT_FROM_WIN32(GetLastError()); }

static double now_ms(void) {
  static LARGE_INTEGER freq;
  LARGE_INTEGER t;
  if (!freq.QuadPart) QueryPerformanceFrequency(&freq);
  QueryPerformanceCounter(&t);
  return (double)t.QuadPart * 1000.0 / (double)freq.QuadPart;
}

static int parse_u64(const wchar_t *text, unsigned long long *out) {
  wchar_t *end;
  if (!text || *text < L'0' || *text > L'9') return 0;
  *out = _wcstoui64(text, &end, 10);
  return *end == L'\0' && *out != _UI64_MAX;
}

static unsigned parse_relax(const wchar_t *text) {
  unsigned mask = 0;
  std::wstring list(text);
  size_t start = 0;
  while (start <= list.size()) {
    size_t comma = list.find(L',', start);
    std::wstring item = list.substr(start, comma == std::wstring::npos ? std::wstring::npos
                                                                       : comma - start);
    if (item == L"job") mask |= RELAX_JOB;
    else if (item == L"ui") mask |= RELAX_UI;
    else if (item == L"low") mask |= RELAX_LOW;
    else if (item == L"mitigations") mask |= RELAX_MITIGATIONS;
    else if (item == L"dlldirs") mask |= RELAX_DLLDIRS;
    else if (item == L"none" || item.empty()) {
    } else fail("usage-relax", E_INVALIDARG);
    if (comma == std::wstring::npos) break;
    start = comma + 1;
  }
  return mask;
}

// Same as heif-decode.c's lock_down, with switches to turn parts off.
static void lock_down(unsigned long long max_memory, unsigned relax) {
  SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
  if (!(relax & RELAX_DLLDIRS) && !SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32))
    fail("dll-directories", last_error());

  if (!(relax & RELAX_JOB)) {
    HANDLE job = CreateJobObjectW(NULL, NULL);
    if (!job) fail("job", last_error());
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
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
    if (!(relax & RELAX_UI)) {
      JOBOBJECT_BASIC_UI_RESTRICTIONS ui;
      ui.UIRestrictionsClass = JOB_OBJECT_UILIMIT_DESKTOP | JOB_OBJECT_UILIMIT_DISPLAYSETTINGS |
                               JOB_OBJECT_UILIMIT_EXITWINDOWS | JOB_OBJECT_UILIMIT_GLOBALATOMS |
                               JOB_OBJECT_UILIMIT_HANDLES | JOB_OBJECT_UILIMIT_READCLIPBOARD |
                               JOB_OBJECT_UILIMIT_SYSTEMPARAMETERS |
                               JOB_OBJECT_UILIMIT_WRITECLIPBOARD;
      if (!SetInformationJobObject(job, JobObjectBasicUIRestrictions, &ui, sizeof ui))
        fail("job-ui", last_error());
    }
    if (!AssignProcessToJobObject(job, GetCurrentProcess())) fail("job-assign", last_error());
  }

  if (!(relax & RELAX_MITIGATIONS)) {
    PROCESS_MITIGATION_EXTENSION_POINT_DISABLE_POLICY extension;
    PROCESS_MITIGATION_IMAGE_LOAD_POLICY image;
    PROCESS_MITIGATION_FONT_DISABLE_POLICY font;
    PROCESS_MITIGATION_STRICT_HANDLE_CHECK_POLICY handles;
    ZeroMemory(&extension, sizeof extension);
    extension.DisableExtensionPoints = 1;
    if (!SetProcessMitigationPolicy(ProcessExtensionPointDisablePolicy, &extension,
                                    sizeof extension))
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
  }

  if (!(relax & RELAX_LOW)) {
    BYTE sid[SECURITY_MAX_SID_SIZE];
    DWORD sid_size = sizeof sid;
    TOKEN_MANDATORY_LABEL label;
    HANDLE token = NULL;
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
}

/** The process token's integrity RID (0x1000 Low, 0x2000 Medium, 0x3000 High). */
static unsigned long integrity_rid(void) {
  HANDLE token = NULL;
  BYTE buffer[256];
  DWORD size = 0;
  unsigned long rid = 0;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return 0;
  if (GetTokenInformation(token, TokenIntegrityLevel, buffer, sizeof buffer, &size)) {
    PSID sid = ((TOKEN_MANDATORY_LABEL *)buffer)->Label.Sid;
    rid = *GetSidSubAuthority(sid, (DWORD)(*GetSidSubAuthorityCount(sid) - 1));
  }
  CloseHandle(token);
  return rid;
}

static int in_job(void) {
  BOOL result = FALSE;
  IsProcessInJob(GetCurrentProcess(), NULL, &result);
  return result ? 1 : 0;
}

/** Bounded JSON writer: once `cap` would be passed, appends nothing more. */
struct Json {
  std::string out;
  size_t cap;
  explicit Json(size_t c) : cap(c) {}
  static std::string utf8(const wchar_t *text, size_t length) {
    if (length == 0) return std::string();
    int n = WideCharToMultiByte(CP_UTF8, 0, text, (int)length, NULL, 0, NULL, NULL);
    std::string s((size_t)(n > 0 ? n : 0), '\0');
    if (n > 0) WideCharToMultiByte(CP_UTF8, 0, text, (int)length, &s[0], n, NULL, NULL);
    return s;
  }
  static std::string str(const hstring &text) {
    std::string raw = utf8(text.c_str(), text.size());
    std::string s = "\"";
    for (unsigned char c : raw) {
      if (c == '"') s += "\\\"";
      else if (c == '\\') s += "\\\\";
      else if (c < 0x20) {
        char esc[8];
        _snprintf(esc, sizeof esc, "\\u%04x", c);
        s += esc;
      } else s += (char)c;
    }
    return s + "\"";
  }
  bool fits(size_t more) const { return out.size() + more + 64 <= cap; }
};

static void write_stdout(const std::string &text) {
  HANDLE out = GetStdHandle(STD_OUTPUT_HANDLE);
  const char *bytes = text.data();
  size_t size = text.size();
  while (size > 0) {
    DWORD written = 0;
    if (!WriteFile(out, bytes, (DWORD)size, &written, NULL) || written == 0)
      fail("output", last_error());
    bytes += written;
    size -= written;
  }
}

static std::string languages_json(void) {
  std::string s = "[";
  bool first = true;
  for (auto const &language : OcrEngine::AvailableRecognizerLanguages()) {
    if (!first) s += ",";
    s += Json::str(language.LanguageTag());
    first = false;
  }
  return s + "]";
}

static std::string user_languages_json(void) {
  std::string s = "[";
  bool first = true;
  for (auto const &tag : winrt::Windows::System::UserProfile::GlobalizationPreferences::Languages()) {
    if (!first) s += ",";
    s += Json::str(tag);
    first = false;
  }
  return s + "]";
}

static __declspec(noreturn) void probe(unsigned relax) {
  lock_down(512ull * 1024 * 1024, relax);
  double t0 = now_ms();
  g_step = "ro-initialize";
  init_apartment(apartment_type::multi_threaded);
  double t1 = now_ms();
  std::string s = "{\"probe\":1";
  char buf[160];
  _snprintf(buf, sizeof buf, ",\"integrity\":%lu,\"in_job\":%d", integrity_rid(), in_job());
  s += buf;
  g_step = "available-languages";
  s += ",\"available\":" + languages_json();
  g_step = "user-languages";
  try {
    s += ",\"user_languages\":" + user_languages_json();
  } catch (hresult_error const &e) {
    _snprintf(buf, sizeof buf, ",\"user_languages_error\":\"0x%08lX\"", (unsigned long)e.code());
    s += buf;
  }
  g_step = "max-dimension";
  _snprintf(buf, sizeof buf, ",\"max_dimension\":%u", OcrEngine::MaxImageDimension());
  s += buf;
  g_step = "user-profile-engine";
  double t2 = now_ms();
  OcrEngine engine = OcrEngine::TryCreateFromUserProfileLanguages();
  double t3 = now_ms();
  s += ",\"user_profile_engine\":";
  s += engine ? Json::str(engine.RecognizerLanguage().LanguageTag()) : std::string("null");
  _snprintf(buf, sizeof buf, ",\"ro_init_ms\":%.2f,\"engine_ms\":%.2f}\n", t1 - t0, t3 - t2);
  s += buf;
  write_stdout(s);
  report("ocr-text:1 probe ok\n");
  ExitProcess(0);
}

/** All of stdin, at most `max` bytes. */
static std::vector<BYTE> read_input(unsigned long long max) {
  HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
  if (in == INVALID_HANDLE_VALUE || in == NULL) fail("input", E_HANDLE);
  if (max == 0 || max > 0x7fffffffull) fail("input", E_INVALIDARG);
  std::vector<BYTE> buffer((size_t)max + 1);
  unsigned long long total = 0;
  for (;;) {
    DWORD got = 0;
    DWORD want = (DWORD)(max + 1 - total);
    if (want == 0) fail("input-too-large", E_INVALIDARG);
    if (!ReadFile(in, buffer.data() + total, want, &got, NULL)) {
      if (GetLastError() == ERROR_BROKEN_PIPE) break;
      fail("input", last_error());
    }
    if (got == 0) break;
    total += got;
    if (total > max) fail("input-too-large", E_INVALIDARG);
  }
  if (total == 0) fail("input", E_INVALIDARG);
  buffer.resize((size_t)total);
  return buffer;
}

/**
 * Decodes the PNG with WIC's PNG decoder only (as heif-decode.exe does), checks its size
 * before any pixel, scales it to fit `max_dim`, and copies it into a Bgra8 SoftwareBitmap.
 */
static SoftwareBitmap decode_wic(std::vector<BYTE> &bytes, unsigned long long max_pixels,
                                 UINT max_dim, UINT *width, UINT *height, double *scale) {
  com_ptr<IWICImagingFactory> wic;
  com_ptr<IWICStream> stream;
  com_ptr<IWICBitmapDecoder> decoder;
  com_ptr<IWICBitmapFrameDecode> frame;
  com_ptr<IWICBitmapScaler> scaler;
  com_ptr<IWICFormatConverter> converter;
  HRESULT hr;
  g_step = "wic";
  hr = CoCreateInstance(CLSID_WICImagingFactory, NULL, CLSCTX_INPROC_SERVER,
                        IID_PPV_ARGS(wic.put()));
  if (FAILED(hr)) fail("wic", hr);
  hr = wic->CreateStream(stream.put());
  if (SUCCEEDED(hr)) hr = stream->InitializeFromMemory(bytes.data(), (DWORD)bytes.size());
  if (FAILED(hr)) fail("stream", hr);
  hr = wic->CreateDecoder(GUID_ContainerFormatPng, NULL, decoder.put());
  if (FAILED(hr)) fail("no-decoder", hr);
  hr = decoder->Initialize(stream.get(), WICDecodeMetadataCacheOnDemand);
  if (FAILED(hr)) fail("open", hr);
  hr = decoder->GetFrame(0, frame.put());
  if (FAILED(hr)) fail("frame", hr);
  hr = frame->GetSize(width, height);
  if (FAILED(hr)) fail("size", hr);
  if (*width == 0 || *height == 0 || (unsigned long long)*width * *height > max_pixels)
    fail("too-many-pixels", E_INVALIDARG);
  UINT out_w = *width, out_h = *height;
  IWICBitmapSource *source = frame.get();
  *scale = 1.0;
  if (out_w > max_dim || out_h > max_dim) {
    *scale = (double)max_dim / (double)(out_w > out_h ? out_w : out_h);
    out_w = (UINT)(out_w * *scale);
    out_h = (UINT)(out_h * *scale);
    if (!out_w) out_w = 1;
    if (!out_h) out_h = 1;
    hr = wic->CreateBitmapScaler(scaler.put());
    if (SUCCEEDED(hr))
      hr = scaler->Initialize(source, out_w, out_h, WICBitmapInterpolationModeFant);
    if (FAILED(hr)) fail("scale", hr);
    source = scaler.get();
  }
  hr = wic->CreateFormatConverter(converter.put());
  if (SUCCEEDED(hr))
    hr = converter->Initialize(source, GUID_WICPixelFormat32bppPBGRA, WICBitmapDitherTypeNone,
                               NULL, 0.0, WICBitmapPaletteTypeCustom);
  if (FAILED(hr)) fail("convert", hr);
  UINT stride = out_w * 4;
  UINT size = stride * out_h;
  g_step = "buffer";
  Buffer buffer(size);
  hr = converter->CopyPixels(NULL, stride, size, buffer.data());
  if (FAILED(hr)) fail("decode", hr);
  buffer.Length(size);
  bytes.clear();
  bytes.shrink_to_fit();
  g_step = "software-bitmap";
  return SoftwareBitmap::CreateCopyFromBuffer(buffer, BitmapPixelFormat::Bgra8, (int32_t)out_w,
                                              (int32_t)out_h, BitmapAlphaMode::Premultiplied);
}

/** Decodes with Windows.Graphics.Imaging's BitmapDecoder (PNG decoder id only). */
static SoftwareBitmap decode_winrt(std::vector<BYTE> &bytes, unsigned long long max_pixels,
                                   UINT max_dim, UINT *width, UINT *height, double *scale) {
  g_step = "winrt-stream";
  InMemoryRandomAccessStream stream;
  {
    DataWriter writer(stream);
    writer.WriteBytes(array_view<const uint8_t>(bytes.data(), bytes.data() + bytes.size()));
    writer.StoreAsync().get();
    writer.DetachStream();
  }
  stream.Seek(0);
  g_step = "winrt-decoder";
  BitmapDecoder decoder = BitmapDecoder::CreateAsync(BitmapDecoder::PngDecoderId(), stream).get();
  *width = decoder.PixelWidth();
  *height = decoder.PixelHeight();
  if (*width == 0 || *height == 0 || (unsigned long long)*width * *height > max_pixels)
    fail("too-many-pixels", E_INVALIDARG);
  *scale = 1.0;
  BitmapTransform transform;
  if (*width > max_dim || *height > max_dim) {
    *scale = (double)max_dim / (double)(*width > *height ? *width : *height);
    transform.ScaledWidth((uint32_t)(*width * *scale));
    transform.ScaledHeight((uint32_t)(*height * *scale));
    transform.InterpolationMode(BitmapInterpolationMode::Fant);
  }
  g_step = "winrt-pixels";
  return decoder
      .GetSoftwareBitmapAsync(BitmapPixelFormat::Bgra8, BitmapAlphaMode::Premultiplied, transform,
                              ExifOrientationMode::IgnoreExifOrientation,
                              ColorManagementMode::DoNotColorManage)
      .get();
}

struct Options {
  std::wstring lang = L"auto";
  bool winrt_decoder = false;
  unsigned long long repeat = 1;
  unsigned long long max_input = 32ull * 1024 * 1024;
  unsigned long long max_pixels = 100000000ull;
  unsigned long long max_memory = 512ull * 1024 * 1024;
  unsigned long long max_output = 1024ull * 1024;
  unsigned relax = 0;
};

static __declspec(noreturn) void recognize(Options const &o) {
  lock_down(o.max_memory, o.relax);
  std::vector<BYTE> bytes = read_input(o.max_input);

  g_step = "ro-initialize";
  init_apartment(apartment_type::multi_threaded);

  double t0 = now_ms();
  g_step = "engine";
  OcrEngine engine{nullptr};
  if (o.lang == L"auto") {
    engine = OcrEngine::TryCreateFromUserProfileLanguages();
  } else {
    winrt::Windows::Globalization::Language language{hstring(o.lang)};
    if (!OcrEngine::IsLanguageSupported(language)) fail("language-not-installed", E_INVALIDARG);
    engine = OcrEngine::TryCreateFromLanguage(language);
  }
  if (!engine) fail("no-engine", E_NOTIMPL);
  double t1 = now_ms();

  UINT width = 0, height = 0;
  double scale = 1.0;
  UINT max_dim = OcrEngine::MaxImageDimension();
  SoftwareBitmap bitmap = o.winrt_decoder
                              ? decode_winrt(bytes, o.max_pixels, max_dim, &width, &height, &scale)
                              : decode_wic(bytes, o.max_pixels, max_dim, &width, &height, &scale);
  double t2 = now_ms();

  g_step = "recognize";
  OcrResult result = engine.RecognizeAsync(bitmap).get();
  double t3 = now_ms();
  double warm = 0;
  for (unsigned long long i = 1; i < o.repeat; i++) {
    double a = now_ms();
    result = engine.RecognizeAsync(bitmap).get();
    warm += now_ms() - a;
  }
  if (o.repeat > 1) warm /= (double)(o.repeat - 1);

  g_step = "output";
  Json j((size_t)o.max_output);
  char buf[256];
  j.out = "{\"v\":1,\"lang\":" + Json::str(engine.RecognizerLanguage().LanguageTag());
  j.out += ",\"available\":" + languages_json();
  _snprintf(buf, sizeof buf, ",\"width\":%u,\"height\":%u", width, height);
  j.out += buf;
  auto angle = result.TextAngle();
  if (angle) _snprintf(buf, sizeof buf, ",\"angle\":%.3f", angle.Value());
  else _snprintf(buf, sizeof buf, ",\"angle\":null");
  j.out += buf;
  j.out += ",\"lines\":[";
  bool truncated = false;
  unsigned lines = 0;
  size_t chars = 0;
  for (auto const &line : result.Lines()) {
    float x0 = 1e30f, y0 = 1e30f, x1 = -1e30f, y1 = -1e30f;
    for (auto const &word : line.Words()) {
      auto r = word.BoundingRect();
      if (r.X < x0) x0 = r.X;
      if (r.Y < y0) y0 = r.Y;
      if (r.X + r.Width > x1) x1 = r.X + r.Width;
      if (r.Y + r.Height > y1) y1 = r.Y + r.Height;
    }
    if (x1 < x0) x0 = y0 = x1 = y1 = 0;
    // Boxes in input-image pixels.
    double inv = 1.0 / scale;
    std::string item = lines ? "," : "";
    _snprintf(buf, sizeof buf, "{\"box\":[%.0f,%.0f,%.0f,%.0f],\"text\":", x0 * inv, y0 * inv,
              (x1 - x0) * inv, (y1 - y0) * inv);
    item += buf;
    item += Json::str(line.Text()) + "}";
    if (!j.fits(item.size())) {
      truncated = true;
      break;
    }
    j.out += item;
    lines++;
    chars += line.Text().size();
  }
  j.out += "],\"truncated\":";
  j.out += truncated ? "true" : "false";
  j.out += "}\n";
  write_stdout(j.out);

  PROCESS_MEMORY_COUNTERS_EX memory;
  ZeroMemory(&memory, sizeof memory);
  memory.cb = sizeof memory;
  GetProcessMemoryInfo(GetCurrentProcess(), (PROCESS_MEMORY_COUNTERS *)&memory, sizeof memory);
  char line[512];
  std::string tag = Json::utf8(engine.RecognizerLanguage().LanguageTag().c_str(),
                               engine.RecognizerLanguage().LanguageTag().size());
  _snprintf(line, sizeof line - 1,
            "ocr-text:1 ok lang=%s lines=%u chars=%zu width=%u height=%u scale=%.4f "
            "decode_ms=%.2f engine_ms=%.2f ocr_ms=%.2f ocr_warm_ms=%.2f peak_commit=%zu "
            "peak_ws=%zu integrity=%lu in_job=%d\n",
            tag.c_str(), lines, chars, width, height, scale, t2 - t1, t1 - t0, t3 - t2, warm,
            (size_t)memory.PeakPagefileUsage, (size_t)memory.PeakWorkingSetSize, integrity_rid(),
            in_job());
  line[sizeof line - 1] = '\0';
  report(line);
  ExitProcess(0);
}

static int run(int argc, wchar_t **argv) {
  Options o;
  bool probing = false;
  int i = 1;
  if (argc >= 2 && wcscmp(argv[1], L"--probe") == 0) probing = true;
  else if (argc < 2 || wcscmp(argv[1], L"--recognize") != 0) fail("usage", E_INVALIDARG);
  for (i = 2; i + 1 < argc; i += 2) {
    const wchar_t *name = argv[i];
    const wchar_t *value = argv[i + 1];
    if (wcscmp(name, L"--relax") == 0) o.relax = parse_relax(value);
    else if (probing) fail("usage", E_INVALIDARG);
    else if (wcscmp(name, L"--lang") == 0) o.lang = value;
    else if (wcscmp(name, L"--decoder") == 0) {
      if (wcscmp(value, L"wic") == 0) o.winrt_decoder = false;
      else if (wcscmp(value, L"winrt") == 0) o.winrt_decoder = true;
      else fail("usage", E_INVALIDARG);
    } else if (wcscmp(name, L"--repeat") == 0) {
      if (!parse_u64(value, &o.repeat) || o.repeat == 0 || o.repeat > 20) fail("usage", E_INVALIDARG);
    } else if (wcscmp(name, L"--max-input") == 0) {
      if (!parse_u64(value, &o.max_input)) fail("usage", E_INVALIDARG);
    } else if (wcscmp(name, L"--max-pixels") == 0) {
      if (!parse_u64(value, &o.max_pixels)) fail("usage", E_INVALIDARG);
    } else if (wcscmp(name, L"--max-memory") == 0) {
      if (!parse_u64(value, &o.max_memory) || o.max_memory < MIN_MEMORY) fail("usage", E_INVALIDARG);
    } else if (wcscmp(name, L"--max-output") == 0) {
      if (!parse_u64(value, &o.max_output) || o.max_output < 256) fail("usage", E_INVALIDARG);
    } else fail("usage", E_INVALIDARG);
  }
  if (i != argc) fail("usage", E_INVALIDARG);
  if (probing) probe(o.relax);
  recognize(o);
}

int wmain(int argc, wchar_t **argv) {
  try {
    return run(argc, argv);
  } catch (hresult_error const &e) {
    fail(g_step, e.code());
  } catch (...) {
    fail(g_step, E_UNEXPECTED);
  }
}
