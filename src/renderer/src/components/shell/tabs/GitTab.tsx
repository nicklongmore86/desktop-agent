/** The Workspace panel's Git tab: an empty host for now. The git panel replaces this component. */
export function GitTab(): React.JSX.Element {
  return (
    <section className="git-tab" aria-label="Git">
      <p className="sidebar-hint">Git status, changes and pull requests will appear here.</p>
    </section>
  )
}
