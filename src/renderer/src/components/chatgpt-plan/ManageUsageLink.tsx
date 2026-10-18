import { MANAGE_USAGE_URL } from '../../../../shared/chatgpt-plan'

/**
 * Opens ChatGPT's usage settings in the user's browser. The address is the fixed constant,
 * never anything a response carried; target=_blank hands it to the main process's
 * window-open handler, the same path every link in the app takes.
 */
export function ManageUsageLink({
  className,
  label = 'Manage usage',
}: {
  className?: string
  label?: string
}): React.JSX.Element {
  return (
    <a
      className={className ? `manage-usage ${className}` : 'manage-usage'}
      href={MANAGE_USAGE_URL}
      target="_blank"
      rel="noreferrer noopener"
    >
      {label}
    </a>
  )
}
