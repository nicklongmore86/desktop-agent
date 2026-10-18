import type { ProviderStatus } from '../../../../shared/ipc'
import type { ProviderKey } from '../../../../shared/access-matrix'
import type { AccessType, ConnectionId, ConnectionInfo } from '../../../../shared/ipc-connections'

/**
 * The Add connection flow as a small state machine, so the wizard component only
 * draws the current step and the transitions can be tested alone.
 *
 *   provider -> access -> connect -> model -> folder -> done
 *
 * Back walks the same path in reverse until the connection is made; after that
 * (model, folder, done) the connection exists, and Back only revisits the
 * earlier optional steps.
 */
export const STEPS = ['provider', 'access', 'connect', 'model', 'folder', 'done'] as const
export type Step = (typeof STEPS)[number]

export interface FlowState {
  step: Step
  provider: ProviderKey | null
  access: AccessType | null
  /** Null on the connect step while the user still has to pick between Ollama and LM Studio. */
  connection: ConnectionId | null
}

export type FlowEvent =
  | { type: 'provider'; provider: ProviderKey }
  | { type: 'access'; access: AccessType; connection: ConnectionId | null }
  | { type: 'connection'; connection: ConnectionId }
  | { type: 'connected' }
  | { type: 'model-done' }
  | { type: 'folder-done' }
  | { type: 'back' }
  /** Opens the flow on the connect step of a connection that already exists (Set up, Sign in). */
  | { type: 'start-at'; provider: ProviderKey; access: AccessType; connection: ConnectionId }

export const initialFlow: FlowState = {
  step: 'provider',
  provider: null,
  access: null,
  connection: null,
}

export function flowReducer(state: FlowState, event: FlowEvent): FlowState {
  switch (event.type) {
    case 'provider':
      return { step: 'access', provider: event.provider, access: null, connection: null }
    case 'access':
      if (state.step !== 'access' || !state.provider) return state
      return { ...state, step: 'connect', access: event.access, connection: event.connection }
    case 'connection':
      if (state.step !== 'connect') return state
      return { ...state, connection: event.connection }
    case 'connected':
      return state.step === 'connect' && state.connection ? { ...state, step: 'model' } : state
    case 'model-done':
      return state.step === 'model' ? { ...state, step: 'folder' } : state
    case 'folder-done':
      return state.step === 'folder' ? { ...state, step: 'done' } : state
    case 'start-at':
      return {
        step: 'connect',
        provider: event.provider,
        access: event.access,
        connection: event.connection,
      }
    case 'back':
      switch (state.step) {
        case 'access':
          return { ...initialFlow }
        case 'connect':
          return { ...state, step: 'access', access: null, connection: null }
        case 'model':
          return { ...state, step: 'connect' }
        case 'folder':
          return { ...state, step: 'model' }
        default:
          return state
      }
  }
}

export const canGoBack = (state: FlowState): boolean =>
  state.step !== 'provider' && state.step !== 'done'

/** Where the user is, for "Step 2 of 5". The done screen is not a step. */
export function stepNumber(step: Step): { current: number; total: number } {
  return { current: Math.min(STEPS.indexOf(step) + 1, 5), total: 5 }
}

/** True once the connection can answer: signed in, or ready with nothing to sign in to. */
export function isConnected(status: ProviderStatus | null | undefined): boolean {
  return Boolean(
    status && (status.signedIn || status.state === 'ready' || status.state === 'limited'),
  )
}

/**
 * A connection the user can chat with now. API-key connections report "ready"
 * whether or not a key is saved, so for them the saved key decides.
 */
export function isReady(
  info: ConnectionInfo,
  status: ProviderStatus | null | undefined,
  keySaved: boolean | undefined,
): boolean {
  if (info.capabilities.authKind === 'api-key') return keySaved === true
  return isConnected(status)
}
