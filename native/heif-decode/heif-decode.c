// heif-decode.exe: decodes one HEIC photo with Windows' own codecs (the Windows Imaging
// Component's HEIF decoder, from "HEIF Image Extensions", and the HEVC decoder from "HEVC
// Video Extensions") into a PNG of at most --long-edge pixels on its long side. The app
// does not bundle an HEVC decoder.
//
//   heif-decode.exe --probe
//   heif-decode.exe --decode --format heif|jpeg --long-edge <px> --max-pixels <n>
//                   --max-input <bytes> --max-memory <bytes>
//
// The photo is untrusted, so before reading a byte of it the process locks itself down:
// - it joins a Job Object of its own that allows no other process (so it cannot start
//   one), caps its memory and CPU time, kills it on an unhandled exception, and denies
//   desktop, clipboard, global atoms and other processes' USER handles;
// - it lowers its token to Low integrity, so it cannot write the user's files, registry
//   or other processes;
// - it turns on mitigations: no legacy extension points (AppInit DLLs, hooks), no DLLs
//   from remote shares or Low-labelled files, System32 first, no non-system fonts, and
//   invalid handle use raises an exception.
// If any of that fails, it decodes nothing.
//
// --decode reads the photo from stdin (at most --max-input bytes), checks the frame size
// the decoder reports against --max-pixels before asking for any pixel, scales it to fit
// --long-edge and writes a 24-bit PNG (no metadata) to stdout. --format jpeg uses WIC's
// JPEG decoder instead, so the whole path can be tested where no HEIF codec is installed.
//
// It writes exactly one report line to stderr, then exits (0 on success, 1 otherwise):
//   heif-decode:1 probe heif=<0|1> hevc=<0|1>
//   heif-decode:1 ok width=<px> height=<px>
//   heif-decode:1 error=<step> code=<0xHRESULT>

#define COBJMACROS
#define _CRT_SECURE_NO_WARNINGS
#include <initguid.h>
#include <windows.h>
#include <mfapi.h>
#include <mfidl.h>
#include <limits.h>
#include <objbase.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>
#include <wincodec.h>

#define CPU_SECONDS 60
#define MIN_MEMORY (64ull * 1024 * 1024)

static void report(const char *line) {
  DWORD written;
  HANDLE err = GetStdHandle(STD_ERROR_HANDLE);
  if (err != INVALID_HANDLE_VALUE && err != NULL)
    WriteFile(err, line, (DWORD)strlen(line), &written, NULL);
}

static __declspec(noreturn) void fail(const char *step, HRESULT hr) {
  char line[128];
  _snprintf(line, sizeof line - 1, "heif-decode:1 error=%s code=0x%08lX\n", step,
            (unsigned long)hr);
  line[sizeof line - 1] = '\0';
  report(line);
  ExitProcess(1);
}

static HRESULT last_error(void) { return HRESULT_FROM_WIN32(GetLastError()); }

static int parse_u64(const wchar_t *text, unsigned long long *out) {
  wchar_t *end;
  if (!text || *text < L'0' || *text > L'9') return 0;
  *out = _wcstoui64(text, &end, 10);
  return *end == L'\0' && *out != _UI64_MAX;
}

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

static IWICImagingFactory *factory(void) {
  IWICImagingFactory *wic = NULL;
  HRESULT hr = CoInitializeEx(NULL, COINIT_MULTITHREADED | COINIT_DISABLE_OLE1DDE);
  if (FAILED(hr)) fail("com", hr);
  hr = CoCreateInstance(&CLSID_WICImagingFactory, NULL, CLSCTX_INPROC_SERVER,
                        &IID_IWICImagingFactory, (void **)&wic);
  if (FAILED(hr)) fail("wic", hr);
  return wic;
}

/** Whether a HEVC video decoder (an MFT) is registered, for HEIC's pixels. */
static int has_hevc_decoder(void) {
  MFT_REGISTER_TYPE_INFO input;
  IMFActivate **found = NULL;
  UINT32 count = 0;
  UINT32 i;
  if (FAILED(MFStartup(MF_VERSION, MFSTARTUP_LITE))) return 0;
  input.guidMajorType = MFMediaType_Video;
  input.guidSubtype = MFVideoFormat_HEVC;
  if (FAILED(MFTEnumEx(MFT_CATEGORY_VIDEO_DECODER,
                       MFT_ENUM_FLAG_SYNCMFT | MFT_ENUM_FLAG_ASYNCMFT | MFT_ENUM_FLAG_HARDWARE |
                           MFT_ENUM_FLAG_SORTANDFILTER,
                       &input, NULL, &found, &count)))
    count = 0;
  for (i = 0; i < count; i++) IMFActivate_Release(found[i]);
  CoTaskMemFree(found);
  MFShutdown();
  return count > 0;
}

static void probe(void) {
  IWICImagingFactory *wic = factory();
  IWICBitmapDecoder *decoder = NULL;
  char line[96];
  int heif = SUCCEEDED(IWICImagingFactory_CreateDecoder(wic, &GUID_ContainerFormatHeif, NULL,
                                                        &decoder));
  if (decoder) IWICBitmapDecoder_Release(decoder);
  _snprintf(line, sizeof line - 1, "heif-decode:1 probe heif=%d hevc=%d\n", heif,
            has_hevc_decoder());
  line[sizeof line - 1] = '\0';
  report(line);
  ExitProcess(0);
}

/** All of stdin, at most `max` bytes. */
static BYTE *read_input(unsigned long long max, DWORD *size) {
  HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
  BYTE *buffer;
  unsigned long long total = 0;
  if (in == INVALID_HANDLE_VALUE || in == NULL) fail("input", E_HANDLE);
  if (max == 0 || max > 0x7fffffffull) fail("input", E_INVALIDARG);
  buffer = (BYTE *)HeapAlloc(GetProcessHeap(), 0, (SIZE_T)max + 1);
  if (!buffer) fail("input", E_OUTOFMEMORY);
  for (;;) {
    DWORD got = 0;
    DWORD want = (DWORD)(max + 1 - total);
    if (want == 0) fail("input-too-large", E_INVALIDARG);
    if (!ReadFile(in, buffer + total, want, &got, NULL)) {
      if (GetLastError() == ERROR_BROKEN_PIPE) break;
      fail("input", last_error());
    }
    if (got == 0) break;
    total += got;
    if (total > max) fail("input-too-large", E_INVALIDARG);
  }
  if (total == 0) fail("input", E_INVALIDARG);
  *size = (DWORD)total;
  return buffer;
}

static void write_all(const BYTE *bytes, ULONG size) {
  HANDLE out = GetStdHandle(STD_OUTPUT_HANDLE);
  while (size > 0) {
    DWORD written = 0;
    if (!WriteFile(out, bytes, size, &written, NULL) || written == 0) fail("output", last_error());
    bytes += written;
    size -= written;
  }
}

static void decode(const GUID *container, unsigned long long long_edge,
                   unsigned long long max_pixels, unsigned long long max_input) {
  IWICImagingFactory *wic;
  IWICStream *stream = NULL;
  IWICBitmapDecoder *decoder = NULL;
  IWICBitmapFrameDecode *frame = NULL;
  IWICBitmapScaler *scaler = NULL;
  IWICFormatConverter *converter = NULL;
  IWICBitmapSource *source;
  IWICBitmapEncoder *encoder = NULL;
  IWICBitmapFrameEncode *target = NULL;
  IPropertyBag2 *options = NULL;
  IStream *png = NULL;
  WICPixelFormatGUID format = GUID_WICPixelFormat24bppBGR;
  STATSTG stat;
  HGLOBAL memory = NULL;
  BYTE *pixels;
  BYTE *bytes;
  DWORD size = 0;
  UINT width = 0, height = 0, out_width, out_height, stride, buffer_size;
  HRESULT hr;
  char line[96];

  ZeroMemory(&stat, sizeof stat);
  bytes = read_input(max_input, &size);
  wic = factory();
  hr = IWICImagingFactory_CreateStream(wic, &stream);
  if (SUCCEEDED(hr)) hr = IWICStream_InitializeFromMemory(stream, bytes, size);
  if (FAILED(hr)) fail("stream", hr);
  // Only this format's decoder ever sees the bytes, whatever they claim to be.
  hr = IWICImagingFactory_CreateDecoder(wic, container, NULL, &decoder);
  if (FAILED(hr)) fail("no-decoder", hr);
  hr = IWICBitmapDecoder_Initialize(decoder, (IStream *)stream, WICDecodeMetadataCacheOnDemand);
  if (FAILED(hr)) fail("open", hr);
  hr = IWICBitmapDecoder_GetFrame(decoder, 0, &frame);
  if (FAILED(hr)) fail("frame", hr);
  hr = IWICBitmapFrameDecode_GetSize(frame, &width, &height);
  if (FAILED(hr)) fail("size", hr);
  // Before any pixel is decoded.
  if (width == 0 || height == 0 || (unsigned long long)width * height > max_pixels)
    fail("too-many-pixels", E_INVALIDARG);

  out_width = width;
  out_height = height;
  source = (IWICBitmapSource *)frame;
  if (width > long_edge || height > long_edge) {
    double scale = (double)long_edge / (double)(width > height ? width : height);
    out_width = (UINT)(width * scale + 0.5);
    out_height = (UINT)(height * scale + 0.5);
    if (out_width == 0) out_width = 1;
    if (out_height == 0) out_height = 1;
    hr = IWICImagingFactory_CreateBitmapScaler(wic, &scaler);
    if (SUCCEEDED(hr))
      hr = IWICBitmapScaler_Initialize(scaler, source, out_width, out_height,
                                       WICBitmapInterpolationModeFant);
    if (FAILED(hr)) fail("scale", hr);
    source = (IWICBitmapSource *)scaler;
  }
  hr = IWICImagingFactory_CreateFormatConverter(wic, &converter);
  if (SUCCEEDED(hr))
    hr = IWICFormatConverter_Initialize(converter, source, &GUID_WICPixelFormat24bppBGR,
                                        WICBitmapDitherTypeNone, NULL, 0.0,
                                        WICBitmapPaletteTypeCustom);
  if (FAILED(hr)) fail("convert", hr);

  // long_edge <= 65535, so this cannot overflow.
  stride = (out_width * 3 + 3) & ~3u;
  buffer_size = stride * out_height;
  pixels = (BYTE *)HeapAlloc(GetProcessHeap(), 0, buffer_size);
  if (!pixels) fail("decode", E_OUTOFMEMORY);
  // The codec decodes here: a missing HEVC decoder fails at this point.
  hr = IWICFormatConverter_CopyPixels(converter, NULL, stride, buffer_size, pixels);
  if (FAILED(hr)) fail("decode", hr);
  HeapFree(GetProcessHeap(), 0, bytes);

  hr = CreateStreamOnHGlobal(NULL, TRUE, &png);
  if (SUCCEEDED(hr)) hr = IWICImagingFactory_CreateEncoder(wic, &GUID_ContainerFormatPng, NULL, &encoder);
  if (SUCCEEDED(hr)) hr = IWICBitmapEncoder_Initialize(encoder, png, WICBitmapEncoderNoCache);
  if (SUCCEEDED(hr)) hr = IWICBitmapEncoder_CreateNewFrame(encoder, &target, &options);
  if (SUCCEEDED(hr)) hr = IWICBitmapFrameEncode_Initialize(target, options);
  if (SUCCEEDED(hr)) hr = IWICBitmapFrameEncode_SetSize(target, out_width, out_height);
  if (SUCCEEDED(hr)) hr = IWICBitmapFrameEncode_SetPixelFormat(target, &format);
  if (SUCCEEDED(hr) && !IsEqualGUID(&format, &GUID_WICPixelFormat24bppBGR)) hr = E_UNEXPECTED;
  if (SUCCEEDED(hr))
    hr = IWICBitmapFrameEncode_WritePixels(target, out_height, stride, buffer_size, pixels);
  if (SUCCEEDED(hr)) hr = IWICBitmapFrameEncode_Commit(target);
  if (SUCCEEDED(hr)) hr = IWICBitmapEncoder_Commit(encoder);
  if (SUCCEEDED(hr)) hr = IStream_Stat(png, &stat, STATFLAG_NONAME);
  if (SUCCEEDED(hr) && stat.cbSize.HighPart != 0) hr = E_OUTOFMEMORY;
  if (SUCCEEDED(hr)) hr = GetHGlobalFromStream(png, &memory);
  if (FAILED(hr)) fail("encode", hr);
  write_all((const BYTE *)GlobalLock(memory), stat.cbSize.LowPart);
  GlobalUnlock(memory);

  _snprintf(line, sizeof line - 1, "heif-decode:1 ok width=%u height=%u\n", out_width,
            out_height);
  line[sizeof line - 1] = '\0';
  report(line);
  ExitProcess(0);
}

int wmain(int argc, wchar_t **argv) {
  unsigned long long long_edge = 0, max_pixels = 0, max_input = 0, max_memory = 0;
  const GUID *container = NULL;
  int i;

  if (argc == 2 && wcscmp(argv[1], L"--probe") == 0) {
    lock_down(512ull * 1024 * 1024);
    probe();
  }
  if (argc < 2 || wcscmp(argv[1], L"--decode") != 0) fail("usage", E_INVALIDARG);
  for (i = 2; i + 1 < argc; i += 2) {
    const wchar_t *name = argv[i];
    const wchar_t *value = argv[i + 1];
    if (wcscmp(name, L"--format") == 0) {
      if (wcscmp(value, L"heif") == 0) container = &GUID_ContainerFormatHeif;
      else if (wcscmp(value, L"jpeg") == 0) container = &GUID_ContainerFormatJpeg;
      else fail("usage", E_INVALIDARG);
    } else if (wcscmp(name, L"--long-edge") == 0) {
      if (!parse_u64(value, &long_edge)) fail("usage", E_INVALIDARG);
    } else if (wcscmp(name, L"--max-pixels") == 0) {
      if (!parse_u64(value, &max_pixels)) fail("usage", E_INVALIDARG);
    } else if (wcscmp(name, L"--max-input") == 0) {
      if (!parse_u64(value, &max_input)) fail("usage", E_INVALIDARG);
    } else if (wcscmp(name, L"--max-memory") == 0) {
      if (!parse_u64(value, &max_memory)) fail("usage", E_INVALIDARG);
    } else {
      fail("usage", E_INVALIDARG);
    }
  }
  if (i != argc || !container || long_edge < 16 || long_edge > 65535 ||
      max_pixels == 0 || max_input == 0 || max_memory < MIN_MEMORY)
    fail("usage", E_INVALIDARG);
  lock_down(max_memory);
  decode(container, long_edge, max_pixels, max_input);
  return 1;
}
