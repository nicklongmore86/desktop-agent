/**
 * Sign in with ChatGPT for ChatGPT plan use. Main process only: callers get an
 * access token from getAccessToken(), and only status() is meant for the renderer.
 */
import { openChatgptAuth, type ChatgptAuth, type ChatgptAuthDeps } from './service'

export { ChatgptAuthError, type ChatgptAuthErrorCode } from './errors'
export type { ChatgptAuth, ChatgptAuthStatus, LoginSession, SignOutResult } from './service'

/** Always OpenAI's production endpoints; there is no way to point it elsewhere. */
export const createChatgptAuth = (deps: Omit<ChatgptAuthDeps, 'fetch'>): ChatgptAuth =>
  openChatgptAuth(deps)
