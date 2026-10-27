import { plainText } from '../plain-text'
import type { ChatErrorCode } from '../../../shared/ipc'
import type { Banner } from '../chat-state'
import type { OpenSettings } from '../open-settings'
import { StatusIcon } from './StatusIcon'
import { ManageUsageLink } from './chatgpt-plan/ManageUsageLink'

const TITLES: Record<ChatErrorCode, string> = {
  usage_limit: 'Plan limit reached',
  plan_not_entitled: 'Plan upgrade required',
  model_unavailable: 'Model unavailable',
  auth_expired: 'Sign-in expired',
  runtime_unavailable: 'Runtime unavailable',
  authentication: 'Authentication failed',
  permission: 'Access denied',
  invalid_request: 'Request rejected',
  rate_limit: 'Rate limit reached',
  overloaded: 'Provider is overloaded',
  network: 'Connection problem',
  api: 'Request failed',
  aborted: 'Stopped',
  max_turns: 'Paused',
  max_tokens: 'Reply too long',
  refusal: 'Request declined',
  context_limit: 'Conversation too long',
  protocol: 'Unexpected response',
  no_api_key: 'No API key',
  key_unreadable: 'API key cannot be read',
  busy: 'Still working',
  internal: 'Something went wrong',
}

const SETTINGS_CODES = new Set<ChatErrorCode>([
  'usage_limit',
  'plan_not_entitled',
  'model_unavailable',
  'auth_expired',
  'runtime_unavailable',
  'authentication',
  'permission',
  'no_api_key',
  'key_unreadable',
])

export function ErrorBanner({
  banner,
  onDismiss,
  onOpenSettings,
  onNewChat,
  onContinue,
  continueDisabled = false,
  manageUsage = false,
}: {
  banner: Banner
  onDismiss: () => void
  onOpenSettings: OpenSettings
  onNewChat: () => void
  /**
   * A run paused at its turn limit: sends a continuation in this chat, through the normal
   * send (so the same busy checks, approvals and audit apply). Without it, no button.
   */
  onContinue?: () => void
  /** A reply, command or switch is in flight, so Continue cannot send yet. */
  continueDisabled?: boolean
  /** ChatGPT · Plan is the connection in use: a limit or plan error offers Manage usage. */
  manageUsage?: boolean
}): React.JSX.Element {
  // Stopping, and pausing at the turn limit, are not failures: neither is shown as an error.
  const paused = banner.code === 'max_turns'
  const info = banner.code === 'aborted' || paused
  return (
    <div
      className={`banner ${info ? 'banner-info' : 'banner-error'}`}
      role={info ? 'status' : 'alert'}
      data-code={banner.code}
    >
      {!info && (
        <span className="banner-icon">
          <StatusIcon status="error" />
        </span>
      )}
      <div className="banner-text">
        {/* The pause message names itself ("Paused after 35 steps…"). */}
        {!paused && <strong>{TITLES[banner.code]}. </strong>}
        {plainText(banner.message)}
      </div>
      <div className="banner-actions">
        {manageUsage && (banner.code === 'usage_limit' || banner.code === 'plan_not_entitled') && (
          <ManageUsageLink className="button-primary" />
        )}
        {SETTINGS_CODES.has(banner.code) && (
          <button
            type="button"
            onClick={() => {
              onOpenSettings('accounts')
            }}
          >
            Open Settings
          </button>
        )}
        {paused && onContinue && (
          <button
            type="button"
            className="button-primary"
            disabled={continueDisabled}
            onClick={onContinue}
          >
            Continue
          </button>
        )}
        {banner.code === 'context_limit' && (
          <button type="button" onClick={onNewChat}>
            New chat
          </button>
        )}
        <button type="button" aria-label="Dismiss" onClick={onDismiss}>
          ×
        </button>
      </div>
    </div>
  )
}
