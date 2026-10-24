import type { DocumentLimits } from './limits'
import { DocumentError, type DocumentView } from './types'
import {
  decodeXml,
  elements,
  find,
  parseXml,
  textOf,
  type XmlElement,
  type XmlOptions,
} from './xml'
import { readZipDirectory, readZipEntry, ZipBudget, type ZipEntry } from './zip'

/**
 * An Office Open XML or OpenDocument package: a ZIP read through the guarded reader
 * (zip.ts), with tighter caps on top for the XML inside. Every part is inflated with the
 * real output counted, at most `office.maxPartBytes` each and `office.maxTotalBytes` for
 * the whole package, and parsed with the hardened XML parser (xml.ts).
 */
export class OfficePackage {
  private readonly byName = new Map<string, ZipEntry>()
  private readonly budget: ZipBudget

  private constructor(
    private readonly bytes: Uint8Array,
    entries: ZipEntry[],
    private readonly limits: DocumentLimits,
  ) {
    for (const entry of entries) {
      const name = normalise(entry.name)
      if (!this.byName.has(name)) this.byName.set(name, entry)
    }
    this.budget = new ZipBudget(Math.min(limits.office.maxTotalBytes, limits.zip.maxTotalBytes))
  }

  static open(bytes: Uint8Array, limits: DocumentLimits): OfficePackage {
    return new OfficePackage(bytes, readZipDirectory(bytes, limits.zip), limits)
  }

  /** Part names, as stored (without a leading slash). */
  names(): string[] {
    return [...this.byName.keys()]
  }

  has(name: string): boolean {
    return this.entry(name) !== undefined
  }

  private entry(name: string): ZipEntry | undefined {
    const wanted = normalise(name)
    const exact = this.byName.get(wanted)
    if (exact) return exact
    // Part names are case-insensitive in OPC.
    const lower = wanted.toLowerCase()
    for (const [key, entry] of this.byName) if (key.toLowerCase() === lower) return entry
    return undefined
  }

  /** A part's bytes, or null when the package has no such part. */
  async read(name: string): Promise<Uint8Array | null> {
    const entry = this.entry(name)
    if (!entry) return null
    const max = this.limits.office.maxPartBytes
    if (entry.uncompressedSize > max) {
      throw new DocumentError(
        'too-large',
        `"${entry.name}" is ${mib(entry.uncompressedSize)} uncompressed; parts up to ${mib(max)} can be read here.`,
      )
    }
    return readZipEntry(this.bytes, entry, this.budget, {
      ...this.limits.zip,
      maxEntryBytes: Math.min(max, this.limits.zip.maxEntryBytes),
    })
  }

  /** A part parsed as XML (see parseXml), or null when there is no such part. */
  async xml(
    name: string,
    options: Omit<XmlOptions, 'maxDepth' | 'maxElements' | 'part'> = {},
  ): Promise<XmlElement | null> {
    const bytes = await this.read(name)
    if (!bytes) return null
    return parseXml(decodeXml(bytes), {
      ...options,
      maxDepth: this.limits.office.maxXmlDepth,
      maxElements: this.limits.office.maxXmlElements,
      part: `"${name}"`,
    })
  }

  /**
   * A part's relationships (`dir/_rels/name.rels`): id -> the target part's name, resolved
   * against the part's folder. External targets (links) are left out.
   */
  async relationships(part: string): Promise<Map<string, { type: string; target: string }>> {
    const slash = part.lastIndexOf('/')
    const dir = slash < 0 ? '' : part.slice(0, slash)
    const file = part.slice(slash + 1)
    const relsName = `${dir ? `${dir}/` : ''}_rels/${file}.rels`
    const rels = await this.xml(relsName, { keep: (name) => name === 'rel:Relationship' })
    const out = new Map<string, { type: string; target: string }>()
    for (const rel of elements(rels ?? undefined, 'rel:Relationship')) {
      const { Id: id, Type: type, Target: target, TargetMode: mode } = rel.attrs
      if (!id || !target || mode === 'External') continue
      out.set(id, { type: type ?? '', target: resolvePart(dir, target) })
    }
    return out
  }
}

/** The title and author from an OOXML package's core properties, when it has them. */
export async function coreProperties(
  pkg: OfficePackage,
  meta: DocumentView['meta'],
  part = 'docProps/core.xml',
): Promise<void> {
  const core = await pkg.xml(part, {
    keep: (name) => name === 'cp:coreProperties' || name === 'dc:title' || name === 'dc:creator',
  })
  const title = textOf(find(core ?? undefined, 'dc:title')).trim()
  const author = textOf(find(core ?? undefined, 'dc:creator')).trim()
  if (title) meta.title = title.slice(0, 500)
  if (author) meta.author = author.slice(0, 500)
}

/** A relationship target resolved against the folder of the part that names it. */
export function resolvePart(dir: string, target: string): string {
  const parts = target.startsWith('/') ? [] : dir.split('/').filter(Boolean)
  for (const piece of target.split('/')) {
    if (piece === '' || piece === '.') continue
    if (piece === '..') parts.pop()
    else parts.push(piece)
  }
  return parts.join('/')
}

const normalise = (name: string): string => name.replace(/^\/+/, '')
const mib = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MB`
