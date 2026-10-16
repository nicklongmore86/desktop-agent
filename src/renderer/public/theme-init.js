// Runs before first paint (a blocking script in <head>) so a forced light or dark
// theme never flashes the other one. It only reads the choice the app cached the
// last time it loaded the saved theme; src/theme.ts then confirms it with main.
// Keep the key and the values in sync with src/theme.ts.
try {
  var theme = localStorage.getItem('desktop-agent:theme')
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme
} catch {
  // No storage: follow the system until the saved theme arrives.
}
