/**
 * OpenAI's "Continue with ChatGPT" button: their label, their logo on the left, a plain
 * black or white fill (the page's text colour on its background, so it is the light button
 * on a dark theme and the dark one on a light theme). The logo is OpenAI's own file
 * (assets/openai/, see NOTICE), drawn through a mask so one file serves both fills.
 */
export function ChatgptButton({
  disabled,
  onClick,
}: {
  disabled: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="chatgpt-button"
      data-sign-in="chatgpt"
      disabled={disabled}
      onClick={onClick}
    >
      <span className="chatgpt-button-logo" aria-hidden="true" />
      <span>Continue with ChatGPT</span>
    </button>
  )
}
