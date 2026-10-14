import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  /** Offered in the fallback, e.g. start a new chat; the boundary then renders its children again. */
  onReset: () => Promise<void>
  resetLabel: string
}

interface State {
  failed: boolean
}

/**
 * Defence in depth around the chat view: if rendering untrusted history ever
 * throws, show a recovery screen instead of a blank window.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { failed: false }

  static getDerivedStateFromError(): State {
    return { failed: true }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('chat view crashed', error, info.componentStack)
  }

  private readonly reset = (): void => {
    this.props.onReset().then(
      () => {
        this.setState({ failed: false })
      },
      () => {
        // Stay on the fallback; the user can try again.
      },
    )
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children
    return (
      <div className="banner banner-error" role="alert">
        <div className="banner-text">
          <strong>The chat view hit an error.</strong> The conversation may contain something it
          cannot display.
        </div>
        <button type="button" onClick={this.reset}>
          {this.props.resetLabel}
        </button>
      </div>
    )
  }
}
