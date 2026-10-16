import { z } from 'zod'
import {
  MAX_PROJECT_NAME,
  MAX_PROJECTS,
  PROJECT_ICONS,
  type Project,
} from '../../shared/ipc-projects'
import { CONVERSATION_ID, sanitizeTitle } from './history-store'

/** Project ids are random v4 UUIDs made in main, like conversation ids. */
export const PROJECT_ID = CONVERSATION_ID

export const PROJECTS_VERSION = 1

export interface ProjectsFile {
  version: typeof PROJECTS_VERSION
  /** In display order. */
  projects: Project[]
}

const projectSchema = z.object({
  id: z.string().regex(PROJECT_ID),
  name: z.string(),
  icon: z.enum(PROJECT_ICONS).nullable().catch(null),
})

/**
 * Never throws. Entry by entry: an invalid project (or a duplicate id) is dropped,
 * a bad icon is cleared, names are made plain text again, and unknown keys are
 * dropped. A missing file, or another `version`, gives no projects.
 */
export function parseProjects(input: unknown): Project[] {
  if (typeof input !== 'object' || input === null) return []
  const { version, projects } = input as Record<string, unknown>
  if (version !== PROJECTS_VERSION || !Array.isArray(projects)) return []
  const seen = new Set<string>()
  const result: Project[] = []
  for (const raw of projects) {
    const parsed = projectSchema.safeParse(raw)
    if (!parsed.success || seen.has(parsed.data.id)) continue
    seen.add(parsed.data.id)
    result.push({
      ...parsed.data,
      name: sanitizeTitle(parsed.data.name, MAX_PROJECT_NAME) || 'Untitled project',
    })
    if (result.length === MAX_PROJECTS) break
  }
  return result
}
