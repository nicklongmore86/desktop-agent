// The agent's tools over the real document reader, built on their own (out/main/tools.js)
// for the real-Electron tests of read_document (e2e/read-document.spec.ts).
export { createTools } from './index'
export { PathGuard } from '../permissions/guard'
export { DocumentWorkerHost, documentWorkerPaths } from '../documents/worker-host'
