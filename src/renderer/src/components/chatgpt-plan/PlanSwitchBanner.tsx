/**
 * For people chatting through Codex · ChatGPT: Plus and Pro accounts can use their plan
 * directly. Dismissible; the action opens the setup wizard at ChatGPT · Plan. Codex itself is
 * unchanged by it.
 */
export function PlanSwitchBanner({
  onSetUp,
  onDismiss,
}: {
  onSetUp: () => void
  onDismiss: () => void
}): React.JSX.Element {
  return (
    <div className="banner banner-info plan-switch-banner" role="region" aria-label="New">
      <div className="banner-text">
        <span className="chip chip-ok">New</span>{' '}
        <strong>Use your ChatGPT plan in this app.</strong> ChatGPT Plus and Pro accounts can switch
        to ChatGPT · Plan and sign in with ChatGPT.
      </div>
      <div className="banner-actions">
        <button type="button" onClick={onSetUp}>
          Set up ChatGPT · Plan
        </button>
        <button type="button" aria-label="Dismiss" onClick={onDismiss}>
          ×
        </button>
      </div>
    </div>
  )
}
