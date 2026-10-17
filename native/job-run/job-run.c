// job-run.exe: runs one program inside a Job Object that kills every process in it when
// the job's only handle closes, so nothing a command starts can outlive the command.
//
//   job-run.exe --parent <pid> [--parent-start <filetime>] -- <absolute exe> [args...]
//
// - The job allows no breakaway and kills its processes when its handle closes. Only
//   this process holds that handle (not inheritable), so if job-run.exe exits or is
//   killed, for any reason, the kernel kills the whole tree.
// - The program starts suspended, inheriting only the three standard handles, and runs
//   only once it is in the job.
// - job-run.exe waits for the program and for the parent process (the app). If the
//   parent goes away first, it kills the job and exits. The parent must have been created
//   before job-run.exe (and at exactly --parent-start, if given), so a process that later
//   reuses the parent's id is never mistaken for it.
// - When the program exits, job-run.exe counts the processes it left running in the job,
//   reports the count and exit code on file descriptor 3 if the caller passed one (the
//   program never inherits it, so its own output cannot fake the report), kills the job,
//   waits for it to empty, and exits with the program's exit code.
//
// Report lines on fd 3 (one line, then fd 3 is closed):
//   job-run:1 exit=<code> background=<count>
//   job-run:1 error=<step> code=<win32 error>
// After an error report the program was never resumed (nothing ran) and job-run.exe exits
// with JOB_RUN_FAILED.

#define WIN32_LEAN_AND_MEAN
#define _CRT_SECURE_NO_WARNINGS
#include <windows.h>
#include <errno.h>
#include <io.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>

#define JOB_RUN_FAILED 0x4A520001u /* "JR" + 1 */
#define JOB_RUN_USAGE 0x4A520002u
#define JOB_RUN_PARENT_GONE 0x4A520003u
#define MAX_MEMBERS 4096

static HANDLE report = INVALID_HANDLE_VALUE;

static void write_report(const char *line) {
  DWORD written;
  if (report == INVALID_HANDLE_VALUE) return;
  WriteFile(report, line, (DWORD)strlen(line), &written, NULL);
  CloseHandle(report);
  report = INVALID_HANDLE_VALUE;
}

static void fail(const char *step, DWORD error) {
  char line[128];
  _snprintf(line, sizeof line - 1, "job-run:1 error=%s code=%lu\n", step, error);
  line[sizeof line - 1] = '\0';
  write_report(line);
  fwprintf(stderr, L"job-run: %hs failed (Windows error %lu)\n", step, error);
  ExitProcess(JOB_RUN_FAILED);
}

static void usage(void) {
  fwprintf(stderr,
           L"usage: job-run.exe --parent <pid> [--parent-start <filetime>] -- <absolute exe> "
           L"[args...]\n");
  ExitProcess(JOB_RUN_USAGE);
}

static int parse_u64(const wchar_t *text, unsigned long long *out) {
  wchar_t *end;
  if (!text || !*text || *text < L'0' || *text > L'9') return 0;
  errno = 0;
  *out = _wcstoui64(text, &end, 10);
  return errno == 0 && *end == L'\0';
}

static unsigned long long filetime_u64(FILETIME t) {
  return ((unsigned long long)t.dwHighDateTime << 32) | t.dwLowDateTime;
}

static unsigned long long created_at(HANDLE process) {
  FILETIME created, exited, kernel, user;
  if (!GetProcessTimes(process, &created, &exited, &kernel, &user)) return 0;
  return filetime_u64(created);
}

/* An absolute local path (X:\...), never resolved against the current folder or PATH. */
static int is_absolute(const wchar_t *path) {
  return ((path[0] >= L'A' && path[0] <= L'Z') || (path[0] >= L'a' && path[0] <= L'z')) &&
         path[1] == L':' && path[2] == L'\\';
}

/*
 * Appends one argument quoted so that CommandLineToArgvW and the C runtime read it back
 * exactly: backslashes are doubled only where they precede a quote.
 */
static size_t quote_arg(wchar_t *out, const wchar_t *arg) {
  size_t n = 0;
  const wchar_t *p;
  out[n++] = L'"';
  for (p = arg;; p++) {
    size_t slashes = 0;
    while (*p == L'\\') {
      slashes++;
      p++;
    }
    if (*p == L'\0') {
      for (; slashes; slashes--) {
        out[n++] = L'\\';
        out[n++] = L'\\';
      }
      break;
    }
    if (*p == L'"') {
      for (slashes = slashes * 2 + 1; slashes; slashes--) out[n++] = L'\\';
    } else {
      for (; slashes; slashes--) out[n++] = L'\\';
    }
    out[n++] = *p;
  }
  out[n++] = L'"';
  return n;
}

static wchar_t *command_line(int argc, wchar_t **argv) {
  size_t size = 1, n = 0;
  int i;
  wchar_t *line;
  for (i = 0; i < argc; i++) size += wcslen(argv[i]) * 2 + 3;
  line = (wchar_t *)calloc(size, sizeof(wchar_t));
  if (!line) fail("alloc", ERROR_NOT_ENOUGH_MEMORY);
  for (i = 0; i < argc; i++) {
    if (i) line[n++] = L' ';
    n += quote_arg(line + n, argv[i]);
  }
  line[n] = L'\0';
  return line;
}

/* An inheritable copy of a standard handle, or NULL if there is none. */
static HANDLE inheritable(DWORD which) {
  HANDLE h = GetStdHandle(which), copy = NULL;
  if (h == NULL || h == INVALID_HANDLE_VALUE) return NULL;
  if (!DuplicateHandle(GetCurrentProcess(), h, GetCurrentProcess(), &copy, 0, TRUE,
                       DUPLICATE_SAME_ACCESS))
    fail("DuplicateHandle", GetLastError());
  return copy;
}

static int is_conhost(DWORD pid, const wchar_t *conhost) {
  wchar_t image[MAX_PATH];
  DWORD size = MAX_PATH;
  int match = 0;
  HANDLE p = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!p) return 0;
  if (QueryFullProcessImageNameW(p, 0, image, &size)) match = _wcsicmp(image, conhost) == 0;
  CloseHandle(p);
  return match;
}

/*
 * Processes still running in the job other than `program` (which has exited), not
 * counting console hosts the system started for them. -1 if the job cannot be queried.
 */
static long background_count(HANDLE job, DWORD program) {
  static struct {
    JOBOBJECT_BASIC_PROCESS_ID_LIST list;
    ULONG_PTR more[MAX_MEMBERS];
  } ids;
  wchar_t conhost[MAX_PATH];
  UINT len = GetSystemDirectoryW(conhost, MAX_PATH - 16);
  DWORD i;
  long count = 0;
  if (len == 0 || len >= MAX_PATH - 16) conhost[0] = L'\0';
  else wcscat(conhost, L"\\conhost.exe");
  ids.list.NumberOfAssignedProcesses = MAX_MEMBERS;
  if (!QueryInformationJobObject(job, JobObjectBasicProcessIdList, &ids, sizeof ids, NULL) &&
      GetLastError() != ERROR_MORE_DATA)
    return -1;
  for (i = 0; i < ids.list.NumberOfProcessIdsInList; i++) {
    DWORD pid = (DWORD)ids.list.ProcessIdList[i];
    if (pid == program || (conhost[0] && is_conhost(pid, conhost))) continue;
    count++;
  }
  /* More members than fit in the list: count the rest from the job's accounting. */
  if (ids.list.NumberOfAssignedProcesses > ids.list.NumberOfProcessIdsInList)
    count += (long)(ids.list.NumberOfAssignedProcesses - ids.list.NumberOfProcessIdsInList);
  return count;
}

/* Kills every process in the job and waits (up to 5 s) until none is left. */
static void kill_job(HANDLE job) {
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info;
  int i;
  TerminateJobObject(job, 1);
  for (i = 0; i < 500; i++) {
    if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &info, sizeof info,
                                   NULL) ||
        info.ActiveProcesses == 0)
      return;
    Sleep(10);
  }
}

/* Bad fds are reported by return value, not by ending the process. */
static void ignore_invalid_parameter(const wchar_t *expression, const wchar_t *function,
                                     const wchar_t *file, unsigned int line, uintptr_t reserved) {
  (void)expression;
  (void)function;
  (void)file;
  (void)line;
  (void)reserved;
}

int wmain(int argc, wchar_t **argv) {
  unsigned long long parent_pid = 0, parent_start = 0, self_start;
  int have_parent = 0, have_start = 0, i, first = 0;
  HANDLE parent, job, std_handles[3], list[3], waits[2];
  size_t listed = 0, attr_size = 0;
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
  STARTUPINFOEXW si;
  PROCESS_INFORMATION pi;
  LPPROC_THREAD_ATTRIBUTE_LIST attrs;
  wchar_t *line;
  DWORD code, which;
  long background;
  char message[128];
  intptr_t fd3;

  /* Never load a DLL from the current folder or PATH. */
  SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32);
  /* No "program has stopped working" dialog for job-run.exe itself. */
  SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX);

  /* The report channel: fd 3 from the caller, if any. Never passed to the program. */
  _set_invalid_parameter_handler(ignore_invalid_parameter);
  fd3 = _get_osfhandle(3);
  if (fd3 != -1 && fd3 != -2) {
    if (!DuplicateHandle(GetCurrentProcess(), (HANDLE)fd3, GetCurrentProcess(), &report, 0,
                         FALSE, DUPLICATE_SAME_ACCESS))
      report = INVALID_HANDLE_VALUE;
    _close(3);
  }

  for (i = 1; i < argc; i++) {
    if (wcscmp(argv[i], L"--") == 0) {
      first = i + 1;
      break;
    } else if (wcscmp(argv[i], L"--parent") == 0 && i + 1 < argc) {
      have_parent = parse_u64(argv[++i], &parent_pid) && parent_pid > 0 && parent_pid <= MAXDWORD;
      if (!have_parent) usage();
    } else if (wcscmp(argv[i], L"--parent-start") == 0 && i + 1 < argc) {
      have_start = parse_u64(argv[++i], &parent_start) && parent_start > 0;
      if (!have_start) usage();
    } else {
      usage();
    }
  }
  if (!have_parent || first == 0 || first >= argc || !is_absolute(argv[first])) usage();

  /* The parent must be the process that started us, not a later one with its id. */
  parent = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, (DWORD)parent_pid);
  if (!parent) fail("OpenProcess(parent)", GetLastError());
  self_start = created_at(GetCurrentProcess());
  {
    unsigned long long started = created_at(parent);
    if (started == 0 || started > self_start || (have_start && started != parent_start) ||
        WaitForSingleObject(parent, 0) != WAIT_TIMEOUT) {
      write_report("job-run:1 error=parent code=0\n");
      CloseHandle(parent);
      ExitProcess(JOB_RUN_PARENT_GONE);
    }
  }

  /* The job: unnamed, its only handle not inheritable, no breakaway. */
  job = CreateJobObjectW(NULL, NULL);
  if (!job) fail("CreateJobObject", GetLastError());
  ZeroMemory(&limits, sizeof limits);
  limits.BasicLimitInformation.LimitFlags =
      JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof limits))
    fail("SetInformationJobObject", GetLastError());

  /* Only the three standard handles are inherited. */
  std_handles[0] = inheritable(STD_INPUT_HANDLE);
  std_handles[1] = inheritable(STD_OUTPUT_HANDLE);
  std_handles[2] = inheritable(STD_ERROR_HANDLE);
  for (i = 0; i < 3; i++)
    if (std_handles[i]) list[listed++] = std_handles[i];
  InitializeProcThreadAttributeList(NULL, 1, 0, &attr_size);
  attrs = (LPPROC_THREAD_ATTRIBUTE_LIST)HeapAlloc(GetProcessHeap(), 0, attr_size);
  if (!attrs) fail("HeapAlloc", ERROR_NOT_ENOUGH_MEMORY);
  if (!InitializeProcThreadAttributeList(attrs, 1, 0, &attr_size))
    fail("InitializeProcThreadAttributeList", GetLastError());
  if (listed &&
      !UpdateProcThreadAttribute(attrs, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, list,
                                 listed * sizeof(HANDLE), NULL, NULL))
    fail("UpdateProcThreadAttribute", GetLastError());

  ZeroMemory(&si, sizeof si);
  si.StartupInfo.cb = sizeof si;
  si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  si.StartupInfo.hStdInput = std_handles[0];
  si.StartupInfo.hStdOutput = std_handles[1];
  si.StartupInfo.hStdError = std_handles[2];
  si.lpAttributeList = attrs;

  line = command_line(argc - first, argv + first);
  /* Suspended until it is in the job; same console, environment and folder as ours. */
  if (!CreateProcessW(argv[first], line, NULL, NULL, listed > 0,
                      CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT, NULL, NULL,
                      &si.StartupInfo, &pi))
    fail("CreateProcess", GetLastError());
  free(line);
  if (!AssignProcessToJobObject(job, pi.hProcess)) {
    DWORD error = GetLastError();
    TerminateProcess(pi.hProcess, JOB_RUN_FAILED);
    fail("AssignProcessToJobObject", error);
  }
  for (i = 0; i < 3; i++)
    if (std_handles[i]) CloseHandle(std_handles[i]);
  DeleteProcThreadAttributeList(attrs);
  HeapFree(GetProcessHeap(), 0, attrs);
  if (ResumeThread(pi.hThread) == (DWORD)-1) {
    DWORD error = GetLastError();
    kill_job(job);
    fail("ResumeThread", error);
  }
  CloseHandle(pi.hThread);

  waits[0] = pi.hProcess;
  waits[1] = parent;
  which = WaitForMultipleObjects(2, waits, FALSE, INFINITE);
  if (which != WAIT_OBJECT_0) {
    /* The app is gone (or the wait failed): nothing may outlive it. */
    kill_job(job);
    CloseHandle(pi.hProcess);
    CloseHandle(parent);
    CloseHandle(job);
    ExitProcess(JOB_RUN_PARENT_GONE);
  }
  if (!GetExitCodeProcess(pi.hProcess, &code)) code = JOB_RUN_FAILED;
  background = background_count(job, pi.dwProcessId);
  _snprintf(message, sizeof message - 1, "job-run:1 exit=%lu background=%ld\n", code, background);
  message[sizeof message - 1] = '\0';
  write_report(message);
  kill_job(job);
  CloseHandle(pi.hProcess);
  CloseHandle(parent);
  CloseHandle(job);
  ExitProcess(code);
}
