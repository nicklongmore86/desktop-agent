# Git panel (read-only, local git)

The Workspace panel's Git tab shows, for each granted folder that is a git repository
(or holds repositories directly inside it), the branch, ahead/behind of the tracking
branch from local refs, changed files, a per-file diff and recent commits. It never
writes: no stage, commit, push, fetch or checkout. GitHub (pull requests, checks) is a
later change; `GitTab.tsx` has a `VIEWS` list for its tab.

A repository in a granted folder may have been downloaded from anywhere, so everything
it can configure is treated as hostile. Code: `src/main/git/`.

## Finding git (`detect.ts`)

Nothing is bundled. Git is looked for by absolute path: `Program Files\Git\cmd\git.exe`
and `Git\bin\git.exe` (ProgramW6432, ProgramFiles, ProgramFiles(x86)),
`%LOCALAPPDATA%\Programs\Git\{cmd,bin}\git.exe`,
then absolute `PATH` entries (`/usr/bin`, `/usr/local/bin`, `/opt/homebrew/bin` then
`PATH` elsewhere). A relative or UNC entry, or a git inside a granted folder, is never
used. Each candidate is resolved to its real path (symbolic links and junctions); one
that cannot be resolved, resolves into a granted folder or to a network path is skipped,
and the real path is what runs. `git --version` must be 2.32 or later. When none is found the panel offers
"Install Git for Windows", which asks main to open a fixed address
(`GIT_INSTALL_URL`); the renderer never sends a URL.

## Before git runs (`repo.ts`, `repo-config.ts`)

- The repository folder comes from a grant id and a relative path, resolved through
  PathGuard with no link on the way (`resolveLocation`).
- `.git` must not be a link. A `.git` file's `gitdir:` and a worktree's `commondir` must
  resolve inside the grants with no link on the way; `HEAD`, `index`, `config`,
  `objects`, `refs`, ... must not be links; `objects/info/alternates` is refused.
- A granted folder inside a repository whose top folder is not granted is refused.
- The repository's config is read with `git config --no-includes -z --get-regexp
'^(include|includeif|filter)\.'`. Any include refuses the repository (an include can
  name any path, including a `\\server\share`, and would make the filter list
  incomplete). Every filter name found is disabled on the command line.

## Every invocation (`runner.ts`)

`<empty file>` and `<empty hooks>` below are `/dev/null` on Linux and macOS. On Windows
they are an empty file and an empty folder in the app's own data folder
(`userData\git-empty\empty` and `...\no-hooks`), checked before every use and rebuilt
if anything else is there: a native Git for Windows can resolve `/dev/null` as
`C:\dev\null`, which any user can create.

`spawn(<absolute git>, argv, { cwd: <checked repo root>, env, stdio: ignore/pipe/pipe,
windowsHide })`, never a shell, 15 s timeout (process tree killed), stdout cap per call.

```
git --no-pager --no-optional-locks --literal-pathspecs --no-replace-objects
    --git-dir=<checked> --work-tree=<checked>
    -c core.fsmonitor=false -c core.hooksPath=<empty hooks> -c diff.external=
    -c core.pager=cat -c core.askPass= -c credential.helper= -c protocol.allow=never
    -c log.showSignature=false -c submodule.recurse=false -c diff.ignoreSubmodules=all
    -c status.submoduleSummary=false -c core.excludesFile=<empty file>
    -c core.attributesFile=<empty file> -c diff.orderFile=<empty file>
    -c mailmap.file=<empty file>
    -c mailmap.blob= -c log.mailmap=false -c core.untrackedCache=false
    -c core.splitIndex=false -c gc.auto=0 -c maintenance.auto=false -c color.ui=false
    -c core.quotePath=false -c diff.noprefix=false -c diff.mnemonicPrefix=false
    -c diff.relative=false
    [-c filter.<name>.clean= -c filter.<name>.smudge= -c filter.<name>.process=
     -c filter.<name>.required=false  for each filter in the repository's config]
    <subcommand>
```

Environment: the shell tool's allow-list (`shellEnv`) plus `GIT_TERMINAL_PROMPT=0`,
`GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=<empty file>`, `GIT_ATTR_NOSYSTEM=1`,
`GIT_OPTIONAL_LOCKS=0`, `GIT_NO_LAZY_FETCH=1`, `GIT_NO_REPLACE_OBJECTS=1`,
`GIT_PROTOCOL_FROM_USER=0`, `GIT_PAGER=cat`, `PAGER=cat`, `GIT_ASKPASS=`, `SSH_ASKPASS=`,
`GIT_ADVICE=0`, `LC_ALL=C`, `LANGUAGE=C`. No other `GIT_*` variable is passed on.

Subcommands (fixed; the renderer supplies only a path, validated):

- `status --porcelain=v2 -z --branch --untracked-files=all --ignore-submodules=all --find-renames`
- `diff [--cached] --numstat -z --no-ext-diff --no-textconv --find-renames --`
- `diff [--cached] --no-ext-diff --no-textconv --no-color --find-renames --src-prefix=a/ --dst-prefix=b/ -- <path> [<old path>]`
- `log --no-show-signature --no-mailmap --no-color --no-decorate -z --format=... --max-count=51 --skip=<n> HEAD --`
- `rev-parse -q --verify HEAD` (only to tell "no commits yet" from a failure)

Why no repository program runs: hooks (none run for these commands; hooksPath points
nowhere), fsmonitor (off), external diff and diff drivers (`--no-ext-diff`, `diff.external=`),
textconv (`--no-textconv`), clean/smudge/process filters (each named and emptied, includes
refused so the list is complete), gpg (signatures off), pager (off, no tty), credential
helpers, askpass and any transport incl. partial-clone lazy fetch (`protocol.allow=never`,
`GIT_NO_LAZY_FETCH`), submodules (ignored, so no git runs inside them with their config).
`GIT_OPTIONAL_LOCKS=0` keeps status from rewriting the index. The real-git test
(`git-real.test.ts`) proves the hostile fixture's programs run under plain git and
never under the panel.

## What is shown (`hidden.ts`, `queries.ts`, `redact.ts`)

- Secrets files (`isSecretName`), blocklisted paths, links, files with other hard links,
  folders and unsafe names (control characters, quotes, backslashes, invalid UTF-8): name
  and status only. Their diff is never requested from git.
- A diff is returned only if every `diff --git` header in it is the requested file (a
  pathspec is a prefix, so `-- cfg` could also show `cfg/.env`).
- Untracked files are read by main through `openVerified` (single link, inside grants).
- Diffs over 200 KB or 4000 lines show "Diff too large"; binary files "Binary file changed".
- Secret-looking values (`redactSecrets` plus PEM private-key bodies) become `[REDACTED]`.
- Everything renders as text (`DiffView`, `SafeText`): bidi and control characters shown
  as tokens, never HTML.

Refresh: a watcher per shown repository (recursive on Windows/macOS, top folder and
the git folder on Linux, a worktree's checked git folder included; object store and
lock files ignored), window focus, and Refresh.
