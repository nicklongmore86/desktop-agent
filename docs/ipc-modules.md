# Per-feature IPC modules

Most of the app's IPC lives in `src/shared/ipc.ts`, `src/main/ipc-handlers.ts` and
`src/preload/index.ts`. Those are shared by every change, so parallel features kept
editing the same regions. New features add their own files instead. The sidebar
layout (`layout`) is the first one and the template.

## The files a feature owns

For a feature called `projects`:

| File                                                              | What it holds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/shared/ipc-projects.ts`                                      | `projectsChannels` (channel name constants), the types, constants and limits shared with the renderer, and `ProjectsApi` — the shape it adds to `window.desktopApi` (e.g. `{ projects: { list(): …, create(): … } }`). No `zod` here: the renderer imports this file.                                                                                                                                                                                                                                         |
| `src/main/ipc-projects.ts`                                        | `ProjectsService` (what main provides) and `registerProjectsHandlers(handle, service)`. Check every argument before it reaches the service and throw a message written for the user. Where the arguments are small (`files`, `git`, `projects`) that is a zod schema local to this file; where the value is a large persisted shape (`layout`) this file only checks it is an object, and the full schema in the feature's schema module does the field-by-field validation when the store saves or loads it. |
| `src/main/storage/projects-schema.ts` (if it persists)            | The zod schema and a `parse…` that never throws and falls back to safe defaults.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `src/preload/projects.ts`                                         | `projectsApi(invoke): ProjectsApi`: one line per call, `invoke(channel, ...args)`.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `src/renderer/src/test/fake-api.ts` and `e2e/harness/preload.cjs` | A fake of the new calls (both fakes must satisfy `DesktopApi`; the first is type checked).                                                                                                                                                                                                                                                                                                                                                                                                                    |

`handle` is already wrapped in the trusted-sender check, so a handler never sees a call
from another frame, and the "rejects every channel from an untrusted frame" test covers it
automatically.

## The three registry lines

Each feature adds exactly one line to each of these (alphabetical, so two features
rarely touch the same line), and does not edit `ipc.ts`, `ipc-handlers.ts` or
`preload/index.ts`:

- `src/shared/ipc-features.ts`: add `ProjectsApi` to the `FeatureApis` intersection, and
  `...Object.values(projectsChannels)` to `FEATURE_CHANNELS`.
- `src/main/ipc-features.ts`: add `projects: ProjectsService` to `FeatureServices` and
  `registerProjectsHandlers(handle, services.projects)` to `registerFeatureHandlers`.
- `src/preload/features.ts`: add `...projectsApi(invoke),` to `featureApis`.

Then give main the service: `src/main/index.ts` passes `projects: …` to
`registerIpcHandlers` (the `layout:` entry there is the model; it adapts the settings store).

## Tests to add

- A handler test next to `src/main/ipc-handlers.test.ts`' `layout` block: valid call,
  each kind of bad argument rejected, and `fakeServices` gains the new service. The test
  "registers every renderer -> main channel" reads `FEATURE_CHANNELS`, so it fails until
  the handlers exist and the channels are listed.
- A store or schema test for anything persisted (see `layout-schema.test.ts`).

## Push (main -> renderer) channels

A feature that pushes events keeps its channel constants in its own `ipc-<feature>.ts` too
(`files` is the example: `filesPushChannels`). The shared `PushPayloads` map in `ipc.ts` is
the one place that is still central; extend it with a single line. The preload module gets
`subscribe` as its second argument (`filesApi(invoke, subscribe)`) and exposes an
`on<Event>(listener)` that returns the unsubscribe. Main sends with the `push` helper in
`src/main/index.ts`.

## Layout data

`LayoutPrefs` (`src/shared/ipc-layout.ts`) is stored under `layout` in `settings.json`,
validated by the zod schema in `src/main/storage/layout-schema.ts` (`parseLayout`, called by the settings store; `src/main/ipc-layout.ts` only rejects non-objects) field by field: a bad field falls back to
its default, unknown keys (a path included) are dropped, and a different `version` means
the defaults. New fields are added with a default and no version bump. The renderer
never stores a path; later features that persist per-folder state key it by grant index
and relative path, and drop entries whose grant is gone.
