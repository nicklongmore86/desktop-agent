// Starts the real main bundle (out/main/index.js), not the fake harness. Linux test machines
// often cannot use Chromium's sandbox (root, or restricted user namespaces), which is why the
// tests pass --no-sandbox; app.enableSandbox() would override that and every renderer would die
// on launch, so only there it is left out. Each window still asks for sandbox: true.
const { app } = require('electron')

if (process.platform === 'linux') app.enableSandbox = () => undefined
require('../../out/main/index.js')
