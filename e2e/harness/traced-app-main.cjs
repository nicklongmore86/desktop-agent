// The real main bundle (out/main/index.js), as real-app-main.cjs starts it, plus two things the
// window-behaviour tests need:
//  - E2E_TRACE_FILE: every app.getPath() call is appended to it. The app asks for its data
//    folder ('userData') only once it is going to open grants, settings, history and the
//    audit log, so a copy that never asks never touched them (see single-instance below).
//  - E2E_PACKAGED=1: app.isPackaged reads true, so the real window is built as an installed
//    one is (developer tools off).
// Nothing here is in the installer: electron-builder only packs out/, and this is in e2e/.
const { app } = require('electron')
const { appendFileSync } = require('node:fs')

if (process.platform === 'linux') app.enableSandbox = () => undefined
const trace = process.env.E2E_TRACE_FILE
if (trace) {
  appendFileSync(trace, 'started\n')
  const getPath = app.getPath.bind(app)
  app.getPath = (name) => {
    appendFileSync(trace, `getPath:${name}\n`)
    return getPath(name)
  }
}
if (process.env.E2E_PACKAGED === '1') Object.defineProperty(app, 'isPackaged', { get: () => true })
require('../../out/main/index.js')
