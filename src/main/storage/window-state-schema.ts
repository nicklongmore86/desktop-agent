import { z } from 'zod'
import type { WindowState } from '../../shared/window-state'

/** Far wider than any real display set, narrow enough to reject garbage. */
const COORDINATE_LIMIT = 100_000
const SIZE_LIMIT = 100_000

const windowStateSchema = z.object({
  x: z.number().int().min(-COORDINATE_LIMIT).max(COORDINATE_LIMIT),
  y: z.number().int().min(-COORDINATE_LIMIT).max(COORDINATE_LIMIT),
  width: z.number().int().min(1).max(SIZE_LIMIT),
  height: z.number().int().min(1).max(SIZE_LIMIT),
  maximized: z.boolean().catch(false),
})

/**
 * A saved window state, or undefined when there is none or it is unusable (missing, a
 * non-number, a fraction, NaN, out of range). Never throws. Unknown keys are dropped; a
 * missing or invalid `maximized` means not maximized, so settings files from before this
 * field, and ones that only lost that flag, still restore the size.
 */
export function parseWindowState(value: unknown): WindowState | undefined {
  const parsed = windowStateSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}
