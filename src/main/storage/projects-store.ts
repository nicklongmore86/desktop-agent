import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import {
  MAX_PROJECT_NAME,
  MAX_PROJECTS,
  type Project,
  type ProjectIcon,
  type ProjectMove,
} from '../../shared/ipc-projects'
import { sanitizeTitle } from './history-store'
import { readJsonFile, writeJsonFile } from './json-file'
import { parseProjects, PROJECTS_VERSION, type ProjectsFile } from './projects-schema'

export interface ProjectsStore {
  list: () => Project[]
  has: (id: string) => boolean
  create: (name: string, icon: ProjectIcon | null) => Promise<Project>
  rename: (id: string, name: string, icon: ProjectIcon | null) => Promise<void>
  remove: (id: string) => Promise<void>
  move: (id: string, to: ProjectMove) => Promise<void>
}

export interface ProjectsOptions {
  newId?: () => string
}

function cleanName(name: string): string {
  const clean = sanitizeTitle(name, MAX_PROJECT_NAME)
  if (!clean) throw new Error('Enter a name for the project.')
  return clean
}

/**
 * The projects, global across providers, in `file` (userData/projects.json).
 * Every change is made in memory, then written; writes never overlap and each
 * writes the list as it is when it starts. A failed write puts the list back
 * as it was before that change. An unreadable file is set aside (renamed to
 * `<file>.unreadable`) the first time a change is written, never overwritten.
 */
export async function openProjectsStore(
  file: string,
  options: ProjectsOptions = {},
): Promise<ProjectsStore> {
  const newId = options.newId ?? randomUUID
  let projects: Project[] = []
  let unreadable = false
  try {
    const raw = await readJsonFile(file)
    projects = parseProjects(raw)
    unreadable = raw !== undefined && projects.length === 0 && !isEmptyFile(raw)
  } catch {
    unreadable = true
  }
  let writes: Promise<unknown> = Promise.resolve()

  const write = (): Promise<void> => {
    const next = writes.then(async () => {
      if (unreadable) {
        await fs.rename(file, `${file}.unreadable`).catch(() => {})
        unreadable = false
      }
      await writeJsonFile(file, { version: PROJECTS_VERSION, projects } satisfies ProjectsFile)
    })
    writes = next.catch(() => {})
    return next
  }
  /** Makes a change and writes it; undoes it if the write fails and nothing changed since. */
  const change = async (next: Project[]): Promise<void> => {
    const before = projects
    projects = next
    try {
      await write()
    } catch (error) {
      if (projects === next) projects = before
      throw error
    }
  }
  const find = (id: string): Project => {
    const project = projects.find((p) => p.id === id)
    if (!project) throw new Error('That project no longer exists.')
    return project
  }

  return {
    list: () => projects.map((project) => ({ ...project })),
    has: (id) => projects.some((project) => project.id === id),
    async create(name, icon) {
      const clean = cleanName(name)
      if (projects.length >= MAX_PROJECTS) throw new Error('There are too many projects.')
      const project: Project = { id: newId(), name: clean, icon }
      if (projects.some((p) => p.id === project.id)) throw new Error('Could not add the project.')
      await change([...projects, project])
      return { ...project }
    },
    async rename(id, name, icon) {
      find(id)
      const clean = cleanName(name)
      await change(projects.map((p) => (p.id === id ? { ...p, name: clean, icon } : p)))
    },
    async remove(id) {
      if (!projects.some((p) => p.id === id)) return
      await change(projects.filter((p) => p.id !== id))
    },
    async move(id, to) {
      const project = find(id)
      const rest = projects.filter((p) => p !== project)
      const from = projects.indexOf(project)
      const index =
        to === 'top'
          ? 0
          : to === 'bottom'
            ? rest.length
            : Math.min(rest.length, Math.max(0, from + (to === 'up' ? -1 : 1)))
      if (index === from) return
      await change([...rest.slice(0, index), project, ...rest.slice(index)])
    },
  }
}

/** A file that holds the format but no projects is readable, not damaged. */
function isEmptyFile(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null) return false
  const { version, projects } = raw as Record<string, unknown>
  return version === PROJECTS_VERSION && Array.isArray(projects) && projects.length === 0
}
