// Masks secret-looking values in diff text before it reaches the renderer: the audit
// log's patterns (API keys, tokens, `password = ...`) plus the body of PEM private keys.
import { redactSecrets } from '../permissions/audit'

const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/
const PEM_END = /-----END [A-Z0-9 ]*PRIVATE KEY-----/

/** The diff with secret-looking values replaced by [REDACTED], and whether anything was. */
export function redactDiff(diff: string): { text: string; redacted: boolean } {
  let inKey = false
  const lines = diff.split('\n').map((line) => {
    if (inKey) {
      if (PEM_END.test(line)) inKey = false
      // Keep the diff's +/-/space prefix so the line still reads as part of the diff.
      return PEM_END.test(line) ? line : `${line.slice(0, 1)}[REDACTED]`
    }
    if (PEM_BEGIN.test(line) && !PEM_END.test(line)) inKey = true
    return line
  })
  const text = redactSecrets(lines.join('\n'))
  return { text, redacted: text !== diff }
}
