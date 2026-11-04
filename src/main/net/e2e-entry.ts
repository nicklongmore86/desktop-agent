// The network layer and the real clients on their own (out/main/network.js), for the
// real-Electron tests (e2e/network-proxy.spec.ts). Left out of the installer.
export * from './network'
export { createElectronTransports } from './electron-transports'
export { apiErrorEvent, createClaudeClient } from '../agent/client'
export { createGeminiClient } from '../llm/gemini'
export { geminiErrorEvent } from '../llm/gemini/errors'
export {
  createOpenAICompatClient,
  listOpenAICompatModels,
  openAICompatErrorEvent,
} from '../llm/openai-compat'
