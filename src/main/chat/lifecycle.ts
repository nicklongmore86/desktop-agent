/** The webContents events that end the page a run's approvals were shown in. */
export const PAGE_ENDING_EVENTS = ['did-start-loading', 'render-process-gone', 'destroyed'] as const

export interface EventSource {
  on(event: (typeof PAGE_ENDING_EVENTS)[number], listener: () => void): unknown
}

/**
 * Cancels the run (denying its approvals) whenever the window's page goes
 * away: reload, navigation, renderer crash or close. A prompt shown in the
 * old page can never be answered, so it must not stay pending.
 */
export function cancelOnPageEnd(contents: EventSource, cancel: () => void): void {
  for (const event of PAGE_ENDING_EVENTS) contents.on(event, cancel)
}
