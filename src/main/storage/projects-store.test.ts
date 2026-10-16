import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseProjects } from './projects-schema'
import { openProjectsStore } from './projects-store'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
async function tempFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-projects-'))
  directories.push(dir)
  return join(dir, 'projects.json')
}

const P1 = '4e5f6a7b-8c9d-4e0f-9a1b-3c4d5e6f7a8b'
const P2 = '5f6a7b8c-9d0e-4f1a-8b2c-4d5e6f7a8b9c'
const P3 = '6a7b8c9d-0e1f-4a2b-9c3d-5e6f7a8b9c0d'
const ids = (...list: string[]) => {
  const queue = [...list]
  return () => queue.shift() ?? 'out-of-ids'
}

describe('projects store', () => {
  it('starts empty and writes nothing until a project is made', async () => {
    const file = await tempFile()
    const store = await openProjectsStore(file)
    expect(store.list()).toEqual([])
    await expect(readFile(file, 'utf8')).rejects.toThrow()
  })

  it('creates, renames, reorders and deletes, keeping it all across a restart', async () => {
    const file = await tempFile()
    const store = await openProjectsStore(file, { newId: ids(P1, P2, P3) })
    await store.create('Taxes', '📊')
    await store.create('  Garden\u202E\u0000 plans ', null)
    await store.create('Trip', '🚀')
    await store.rename(P2, 'Garden', '📁')
    await store.move(P3, 'top')
    await store.move(P1, 'down')
    await store.remove(P2)
    const reopened = await openProjectsStore(file)
    expect(reopened.list()).toEqual([
      { id: P3, name: 'Trip', icon: '🚀' },
      { id: P1, name: 'Taxes', icon: '📊' },
    ])
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ version: 1 })
  })

  it('cleans names and refuses empty ones and unknown projects', async () => {
    const file = await tempFile()
    const store = await openProjectsStore(file, { newId: ids(P1) })
    await expect(store.create(' \u200B ', null)).rejects.toThrow('Enter a name')
    const project = await store.create('x'.repeat(200), null)
    expect(Array.from(project.name)).toHaveLength(60)
    await expect(store.rename(P2, 'Nope', null)).rejects.toThrow('no longer exists')
    await expect(store.move(P2, 'up')).rejects.toThrow('no longer exists')
  })

  it('serialises concurrent changes', async () => {
    const file = await tempFile()
    const store = await openProjectsStore(file, { newId: ids(P1, P2, P3) })
    await Promise.all([
      store.create('One', null),
      store.create('Two', null),
      store.create('Three', null),
    ])
    await Promise.all([store.move(P3, 'top'), store.rename(P1, 'Uno', null), store.remove(P2)])
    expect((await openProjectsStore(file)).list().map((p) => p.name)).toEqual(['Three', 'Uno'])
  })

  it('puts a change back when it cannot be written', async () => {
    const file = await tempFile()
    const store = await openProjectsStore(file, { newId: ids(P1, P2) })
    await store.create('Kept', null)
    await rm(file)
    await mkdir(join(file, 'blocker'), { recursive: true })
    await expect(store.create('Lost', null)).rejects.toThrow()
    expect(store.list().map((p) => p.name)).toEqual(['Kept'])
  })

  it('sets an unreadable file aside instead of overwriting it', async () => {
    const file = await tempFile()
    await writeFile(file, '{ not json')
    const store = await openProjectsStore(file, { newId: ids(P1) })
    expect(store.list()).toEqual([])
    await store.create('Fresh', null)
    expect(await readFile(`${file}.unreadable`, 'utf8')).toBe('{ not json')
    expect((await readdir(join(file, '..'))).sort()).toEqual([
      'projects.json',
      'projects.json.unreadable',
    ])
  })
})

describe('parseProjects', () => {
  it('drops bad or duplicate entries, clears bad icons and never throws', () => {
    expect(
      parseProjects({
        version: 1,
        projects: [
          { id: P1, name: 'Good', icon: '🚀', extra: 'C:\\Windows' },
          { id: P1, name: 'Duplicate', icon: null },
          { id: '../../x', name: 'Path id', icon: null },
          { id: P2, name: '<b>\u202E</b>', icon: '💣' },
          { id: P3, name: 5, icon: null },
        ],
      }),
    ).toEqual([
      { id: P1, name: 'Good', icon: '🚀' },
      { id: P2, name: '<b> </b>', icon: null },
    ])
    for (const bad of [undefined, null, 'x', [], { version: 2, projects: [] }, { version: 1 }])
      expect(parseProjects(bad)).toEqual([])
  })
})
