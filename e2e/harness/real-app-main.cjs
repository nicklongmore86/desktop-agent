// The real app (out/main/index.js), with one change: no app.enableSandbox(), which overrides the
// --no-sandbox that Linux CI needs. Everything else, including how main wires its network, is
// what ships. Run `pnpm build` first.
const { app } = require('electron')
app.enableSandbox = () => {}
require('../../out/main/index.js')
