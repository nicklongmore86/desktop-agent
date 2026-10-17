# CI

CI runs on GitHub Actions (`.github/workflows/ci.yml`). Windows runner minutes use up the monthly allowance faster than Linux minutes, so the Windows jobs only run when they are worth it.

## What runs when

| Trigger                                    | Check (ubuntu-latest) | Check (windows-latest) | Windows installer |
| ------------------------------------------ | --------------------- | ---------------------- | ----------------- |
| Push to `main`                             | yes                   | yes                    | yes               |
| Actions → CI → Run workflow (any branch)   | yes                   | yes                    | yes               |
| PR opened or pushed, draft (any labels)    | yes                   | no                     | no                |
| PR opened or pushed, labelled `windows-ci` | yes                   | yes                    | yes               |
| PR opened or pushed, not labelled          | yes                   | no                     | no                |
| PR marked ready for review                 | yes                   | yes                    | yes               |
| `windows-ci` label added to a non-draft PR | yes                   | yes                    | yes               |
| Any other label added, or label on a draft | no                    | no                     | no                |
| Documentation-only change (see below)      | no-op pass            | no                     | no                |

- A newer push to a PR or branch cancels its outdated run. Runs on `main` are never cancelled part-way, so every merge still produces the installer artifact.
- Changes that only touch `**/*.md`, `docs/**`, `.polly/**` or `LICENSE*` skip CI. For PRs, `ci-docs.yml` reports a trivial passing `Check (ubuntu-latest)` instead, so the check is never left pending. It also runs, harmlessly, on PRs that mix docs and code.
- Each job has a timeout (30 minutes on Linux, 45 on Windows) so a hung run can't burn the month's minutes.

## Requesting Windows CI on a PR

- Add the `windows-ci` label. This starts a run straight away and keeps Windows running on every later push to the PR.
- Or open Actions → CI → Run workflow and pick the PR branch. This runs everything once.

Maintainers: add `windows-ci` before merging any PR that touches Windows-specific code, including `src/main/tools/*` (in particular `shell-windows.ts`), `src/main/providers/`, git integration, `src/main/files/`, and the installer (`electron-builder.yml`, packaging scripts, runtime pins). Merging to `main` always runs Windows CI, but catching a failure before merge is cheaper than fixing `main` afterwards.
