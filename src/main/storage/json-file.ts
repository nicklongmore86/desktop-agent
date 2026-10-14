import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'

/** Reads and parses a JSON file. A missing file is `undefined`; anything else unreadable throws. */
export async function readJsonFile(file: string): Promise<unknown> {
  let text: string
  try {
    text = await fs.readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  return JSON.parse(text) as unknown
}

/** Writes JSON to a temp file, then renames it over `file`, so a crash never leaves half a file. */
export async function writeJsonFile(file: string, value: unknown): Promise<void> {
  await fs.mkdir(dirname(file), { recursive: true })
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temp, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 })
    await fs.rename(temp, file)
  } finally {
    // Best effort: after a successful rename there is nothing left to remove.
    await fs.rm(temp, { force: true }).catch(() => {})
  }
}

export async function removeFile(file: string): Promise<void> {
  await fs.rm(file, { force: true })
}
