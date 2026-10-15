// The harness window's web preferences: exactly the app's (secureWebPreferences in
// src/main/security.ts), apart from the preload path. src/main/e2e-harness.test.ts
// fails if the two drift apart.
/** @param {string} preload */
function harnessWebPreferences(preload) {
  return {
    preload,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    experimentalFeatures: false,
    navigateOnDragDrop: false,
    spellcheck: false,
  }
}

module.exports = { harnessWebPreferences }
