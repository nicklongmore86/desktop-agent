import { z } from 'zod'
import {
  DEFAULT_LAYOUT,
  LAYOUT_VERSION,
  LEFT_DEFAULT,
  LEFT_MIN,
  PANE_MAX,
  RIGHT_DEFAULT,
  RIGHT_MIN,
  RIGHT_TABS,
  type LayoutPrefs,
} from '../../shared/ipc-layout'

/** A width: any finite number is rounded and clamped; anything else is the default. */
const width = (min: number, fallback: number) =>
  z
    .number()
    .transform((value) => Math.min(PANE_MAX, Math.max(min, Math.round(value))))
    .catch(fallback)

/**
 * Field by field, so one bad value (or a field from a newer build) costs only that
 * field. Unknown keys, a path included, are dropped. A different `version` means the
 * whole object is from an incompatible build and falls back to the defaults.
 */
export const layoutSchema = z.object({
  version: z.literal(LAYOUT_VERSION),
  leftOpen: z.boolean().catch(DEFAULT_LAYOUT.leftOpen),
  leftWidth: width(LEFT_MIN, LEFT_DEFAULT),
  rightOpen: z.boolean().catch(DEFAULT_LAYOUT.rightOpen),
  rightWidth: width(RIGHT_MIN, RIGHT_DEFAULT),
  rightTab: z.enum(RIGHT_TABS).catch(DEFAULT_LAYOUT.rightTab),
})

/** Never throws: a missing, old or invalid value gives the defaults. */
export function parseLayout(input: unknown): LayoutPrefs {
  const parsed = layoutSchema.safeParse(input)
  return parsed.success ? parsed.data : { ...DEFAULT_LAYOUT }
}
