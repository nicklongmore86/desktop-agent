# job-run.exe: Windows commands in a Job Object

On Windows, every `run_shell` command (the agent's and the command bar's) runs inside a Job Object, through a small helper bundled with the installer, `resources\helpers\job-run.exe` (source: `native/job-run/job-run.c`). Nothing the command starts can outlive it: when the command finishes, is cancelled or times out, or the app itself dies, the kernel kills every process in the job.

## What it does

```
job-run.exe --parent <app pid> [--parent-start <filetime>] -- <absolute powershell.exe> -NoProfile -NonInteractive -EncodedCommand <base64>
```

1. Checks the parent: it must be running and have been created before job-run.exe (and exactly at `--parent-start`, when given). A process that reused the app's pid is never mistaken for it.
2. Creates an unnamed job with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION` and no breakaway flags (`CREATE_BREAKAWAY_FROM_JOB` fails with access denied). Its only handle is not inheritable, so job-run.exe holds the only one.
3. Starts PowerShell with `CreateProcessW` by absolute path, `CREATE_SUSPENDED`, inheriting only the three standard handles (`PROC_THREAD_ATTRIBUTE_HANDLE_LIST`, `STARTF_USESTDHANDLES`), in the same hidden console, environment and folder. It assigns PowerShell to the job and only then resumes it. If any step fails, PowerShell never runs.
4. Waits for PowerShell and for the app. If the app goes first, it kills the job and exits.
5. When PowerShell exits, counts the processes still running in the job (console hosts not counted), reports the count, kills the job, waits up to 5 s for it to empty, and exits with PowerShell's exit code.

Cancel and timeout kill job-run.exe itself (`TerminateProcess`). That closes the job's only handle, and the kernel kills the whole tree, including orphans whose parent already exited, which `taskkill /T` cannot find.

## Background processes

Anything a command leaves running (`Start-Process notepad`, `code .`, a dev server) is stopped when the command finishes. The result says so, for example:

```
exit code: 0
2 background processes were stopped when the command finished.
```

### The report channel

The app passes job-run.exe a fourth pipe (fd 3). job-run.exe duplicates it as a non-inheritable handle and never passes it to PowerShell (only the three standard handles are inherited), then writes exactly one line to it:

```
job-run:1 exit=<code> background=<count>
job-run:1 error=<step> code=<win32 error>     (setup failed; nothing ran)
```

The app reads only this pipe, accepts only one exact line, and ignores anything the command prints, so a command cannot fake the count or a failure by printing those lines on stdout or stderr. A process running as the same user can still, deliberately, open job-run.exe and duplicate the pipe or the job handle out of it; that is within what an approved command can already do (see Limits).

## Integrity and fallback

- CI builds job-run.exe on `windows-latest` with MSVC (`scripts/build-job-helper.mjs`, run as `pnpm build:helpers` before the tests and the app build): `cl /O1 /MT /GS /guard:cf /W4 /WX /Brepro`, linked with `/DYNAMICBASE /HIGHENTROPYVA /NXCOMPAT /guard:cf /CETCOMPAT /DEPENDENTLOADFLAG:0x800` (system32-only DLL search), with a version resource (`native/job-run/job-run.rc`). It imports only `kernel32.dll`. The script fails unless the PE has ASLR, DEP and CFG.
- Its SHA-256 goes into `build/job-helper-pins.json`, which the Vite build compiles into the main bundle (`__JOB_RUN_SHA256__`). The digest is pinned per build, not committed: `/Brepro` makes the bytes reproducible for one compiler version, but the runner's MSVC changes over time. The CI log prints the size, digest and MSVC version.
- `electron-builder` copies it to `resources/helpers`. The after-pack check (`scripts/verify-runtime-bundle.mjs`) fails the build unless the packaged file matches the pin, is hardened, and the main bundle carries the same pin. The installer CI job also runs it from the unpacked install.
- Before every command, the app checks that `resources\helpers\job-run.exe` is a regular file (not a link) whose real path is exactly that location, outside every granted folder, and whose SHA-256 matches the compiled-in pin. It is never looked up on `PATH` or in the working folder.
- If that check fails, or there is no install (development on Windows) or no pin, the command still runs, without a job, and the existing kill path applies (`taskkill /T /F`, then the PowerShell tree-kill fallback). The result ends with the reason, for example `Not run in a Job Object (job-run.exe failed its integrity check); processes the command started may still be running.`, and the app logs it once.

The same build script, pins file, after-pack check and verification
(`verifyPinnedHelper`) cover `heif-decode.exe`, the HEIC decoder (see
[document-reader.md](document-reader.md#heic-photos)), under its own marker
(`heif-decode.exe-sha256:`).

## Processes that escape by design

A Job Object contains only processes created by processes already in it. These are started by something outside the job, so they keep running after the command:

- COM and WMI: `Win32_Process.Create` (`Invoke-CimMethod`, `wmic process call create`) starts the process from the WMI service. Out-of-process COM servers (Office automation, `Shell.Application`, many `New-Object -ComObject` calls) start under the COM launcher (`svchost`/DcomLaunch).
- Services (`sc start`, `Start-Service`) and scheduled tasks (`schtasks /run`, `Register-ScheduledTask`) run under the Service Control Manager or Task Scheduler.
- Hand-off to an app that is already running: `Start-Process https://…` or `start msedge` with Edge open just tells the existing Edge to open a tab; `explorer .` or opening a file can be handled by the existing Explorer; single-instance apps (VS Code with a window open, Teams…) forward the request and the new process exits. The count does not include them, because they are not in the job.
- Anything a same-user process does deliberately to get around it, such as duplicating the job handle out of job-run.exe before it exits.

## Limits

- **Unsigned.** job-run.exe is not code-signed yet (signing is postponed with the installer's). Antivirus and SmartScreen may flag or quarantine a small unsigned executable that starts PowerShell. If it is quarantined or altered, the integrity check fails and commands fall back, with the reason in the result.
- **Same-user boundary.** The app is installed per user, so its files (including job-run.exe and `app.asar`) are writable by any process running as the user. The pin detects corruption and replacement between checks, not a determined local attacker, who could also swap the file between the check and the launch.
- The job is not a sandbox: an approved command can still do anything the user can, as before. It only bounds how long what it starts keeps running.
- If the report pipe is lost (job-run.exe crashed), the result says the launcher did not report and that anything it started was stopped.
