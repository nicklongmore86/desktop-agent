# Window behaviour

How the app window opens, closes and asks for attention. The decisions are small pure modules
with unit tests; `src/main/window-behaviour.ts` wires them to Electron.

| Behaviour                    | Where                                               | Notes                                                                                                                                       |
| ---------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| One copy of the app          | `startup.ts`, `instance-lock.ts`                    | `startup.ts` is imported first. A second copy ends with `app.exit(0)` before any other module of the app loads. `app.quit()` is not enough. |
| AppUserModelID               | `instance-lock.ts`                                  | Equals `appId` in `electron-builder.yml` (a test checks). Gives notifications the app's name and one taskbar button.                        |
| Window size and position     | `window-state.ts`, `storage/window-state-schema.ts` | Saved in `settings.json` as `windowState`. Off every display, invalid or missing: 1000x720 centred. Never below 480x400.                    |
| Close and quit warning       | `close-guard.ts`                                    | Asks when a reply, a typed command, a file action or an approval is in progress. Cancel is the default. No prompt when idle.                |
| Notifications, taskbar flash | `attention.ts`, `window-behaviour.ts`               | Only while the window is not focused and Settings > Notifications is on. Fixed text only.                                                   |
| Developer tools              | `window.ts` (`windowWebPreferences`)                | Off in packaged builds. The hidden document reader window already did this (`worker-host.ts`).                                              |
| Icon                         | `scripts/generate-icon.mjs`, `assets/icon/`         | Placeholder, drawn by the script. `pnpm icon` rewrites it; a test fails if the committed files differ from the script.                      |

## When the close warning does not appear

- Nothing is running and no approval is open.
- Windows is logging off or shutting down (`query-session-end` for 15 seconds, `session-end`), or
  Linux/macOS report a shutdown.
- A crash or hang prompt is on screen: it takes the warning's place and already offers Quit.
- The page has crashed and its work has stopped: losing the page stops the run and denies its
  approvals, so there is nothing left to warn about.
- Code calls `allowQuit()` for a quit the app decided on itself.

A page that is not responding does not turn the warning off. The warning is a native dialog that
reads the work from main, and `unresponsive` can mean a page that is only busy for a moment. After
Keep waiting, a close or quit during work warns as usual. Stop and quit does not need the page:
stopping the work and saving the window state are limited to 5 seconds each.

## Notification text

Always one of three fixed strings (`NOTIFICATION_TEXT`): "Your reply is ready.", "A reply could
not be completed.", "An approval is waiting for your answer." The code that picks one only learns
which event happened, never its content. Clicking a notification brings the window forward and
does nothing else.
