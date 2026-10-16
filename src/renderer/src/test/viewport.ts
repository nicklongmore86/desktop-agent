/** jsdom has no layout: tests choose the window width the shell lays out for (jsdom starts at 1024). */
export function setViewport(width: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width })
  window.dispatchEvent(new Event('resize'))
}
