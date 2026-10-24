import { DocumentError } from './types'

/**
 * A small XML parser for the parts of Office and OpenDocument files, written for hostile
 * input. A DOCTYPE is refused outright, so there are no entity definitions to expand (no
 * billion laughs) and nothing external to load (no XXE); only the five predefined entities
 * and character references are decoded. Nesting depth and the number of elements are
 * capped, and only the elements a reader asks for are kept, so a large part costs little
 * more memory than its text.
 *
 * Names are namespace-resolved: an element or attribute in a known namespace gets that
 * namespace's usual prefix (`w:p`, `a:t`, `text:p`) whatever prefix the file used, so
 * readers match on one spelling. Unknown namespaces keep the file's own qualified name.
 */

export interface XmlElement {
  name: string
  attrs: Record<string, string>
  children: XmlNode[]
}
export type XmlNode = XmlElement | string

export interface XmlOptions {
  /**
   * Which elements to keep: true keeps one, false drops it but keeps what it contains (its
   * kept descendants join the nearest kept ancestor), 'skip' drops it and everything in it.
   * Every element is kept by default.
   */
  keep?: (name: string) => boolean | 'skip'
  /** Text is kept only where its nearest kept element is one of these. Default: everywhere. */
  text?: ReadonlySet<string>
  maxDepth: number
  maxElements: number
  /** For messages: which part this is. */
  part?: string
}

const NAMESPACES: Record<string, string> = {
  'http://schemas.openxmlformats.org/wordprocessingml/2006/main': 'w',
  'http://purl.oclc.org/ooxml/wordprocessingml/main': 'w',
  'http://schemas.openxmlformats.org/drawingml/2006/main': 'a',
  'http://purl.oclc.org/ooxml/drawingml/main': 'a',
  'http://schemas.openxmlformats.org/presentationml/2006/main': 'p',
  'http://purl.oclc.org/ooxml/presentationml/main': 'p',
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships': 'r',
  'http://purl.oclc.org/ooxml/officeDocument/relationships': 'r',
  'http://schemas.openxmlformats.org/package/2006/relationships': 'rel',
  'http://schemas.openxmlformats.org/markup-compatibility/2006': 'mc',
  'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing': 'wp',
  'http://purl.oclc.org/ooxml/drawingml/wordprocessingDrawing': 'wp',
  'http://schemas.openxmlformats.org/drawingml/2006/picture': 'pic',
  'http://purl.oclc.org/ooxml/drawingml/picture': 'pic',
  'urn:schemas-microsoft-com:vml': 'v',
  'http://schemas.openxmlformats.org/package/2006/metadata/core-properties': 'cp',
  'http://purl.org/dc/elements/1.1/': 'dc',
  'urn:oasis:names:tc:opendocument:xmlns:office:1.0': 'office',
  'urn:oasis:names:tc:opendocument:xmlns:text:1.0': 'text',
  'urn:oasis:names:tc:opendocument:xmlns:table:1.0': 'table',
  'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0': 'draw',
  'urn:oasis:names:tc:opendocument:xmlns:presentation:1.0': 'presentation',
  'urn:oasis:names:tc:opendocument:xmlns:meta:1.0': 'meta',
  'urn:oasis:names:tc:opendocument:xmlns:style:1.0': 'style',
  'urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0': 'svg',
  'http://www.w3.org/1999/xlink': 'xlink',
  'http://www.w3.org/XML/1998/namespace': 'xml',
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

/** Decodes the predefined entities and character references; anything else is left as written. */
export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-z]{2,4});/g, (whole, ref: string) => {
    if (ref.startsWith('#')) {
      const code = ref[1] === 'x' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10)
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : ''
    }
    return ENTITIES[ref] ?? whole
  })
}

/** Decodes an XML part's bytes: UTF-16 with a byte-order mark, otherwise UTF-8. */
export function decodeXml(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes)
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes)
  return new TextDecoder('utf-8').decode(bytes)
}

/** Refuses a part that declares a DTD; for parts handed to another parser (SheetJS). */
export function refuseDtd(text: string, part = 'A part'): void {
  if (text.includes('<!DOCTYPE') || text.includes('<!ENTITY')) throw dtd(part)
}

const dtd = (part: string): DocumentError =>
  new DocumentError(
    'malformed',
    `${part} declares a DTD, which Office files never need; it was not read.`,
  )

interface Open {
  /** The name as written, to match the closing tag. */
  raw: string
  element: XmlElement | null
  /** Prefix -> namespace URI declared on this element, when it declares any. */
  scope: Map<string, string> | null
  /** The nearest kept element, this one included, and whether text there is kept. */
  target: XmlElement
  keepsText: boolean
}

/** Parses one XML part into a tree of the elements `options.keep` asks for, under a synthetic root. */
export function parseXml(input: Uint8Array | string, options: XmlOptions): XmlElement {
  const text = typeof input === 'string' ? input : decodeXml(input)
  const part = options.part ?? 'An XML part'
  const malformed = (why: string): DocumentError =>
    new DocumentError('malformed', `${part} is not valid XML: ${why}.`)
  const keep = options.keep ?? (() => true)
  const textIn = options.text
  const root: XmlElement = { name: '#root', attrs: {}, children: [] }
  const stack: Open[] = []
  const scopes: Map<string, string>[] = [new Map([['xml', 'http://www.w3.org/XML/1998/namespace']])]
  let skipping = 0
  let elements = 0
  let rooted = false
  let target = root
  let keepsText = !textIn
  let at = text.charCodeAt(0) === 0xfeff ? 1 : 0

  const lookup = (prefix: string): string | undefined => {
    for (let i = scopes.length - 1; i >= 0; i--) {
      const uri = scopes[i]?.get(prefix)
      if (uri !== undefined) return uri
    }
    return undefined
  }
  const resolve = (qname: string, isAttribute: boolean): string => {
    const colon = qname.indexOf(':')
    const prefix = colon < 0 ? '' : qname.slice(0, colon)
    const local = colon < 0 ? qname : qname.slice(colon + 1)
    // Unprefixed attributes are in no namespace.
    if (colon < 0 && isAttribute) return local
    const uri = lookup(prefix)
    const known = uri === undefined ? undefined : NAMESPACES[uri]
    if (known) return `${known}:${local}`
    return qname
  }

  while (at < text.length) {
    const lt = text.indexOf('<', at)
    const end = lt < 0 ? text.length : lt
    if (end > at && keepsText && !skipping) {
      const chunk = text.slice(at, end)
      if (stack.length > 0) target.children.push(decodeEntities(chunk))
      else if (chunk.trim()) throw malformed('text outside the root element')
    }
    if (lt < 0) break
    at = lt
    const next = text.charCodeAt(at + 1)
    if (next === 0x21 /* ! */) {
      if (text.startsWith('<!--', at)) {
        const close = text.indexOf('-->', at + 4)
        if (close < 0) throw malformed('an unclosed comment')
        at = close + 3
      } else if (text.startsWith('<![CDATA[', at)) {
        const close = text.indexOf(']]>', at + 9)
        if (close < 0) throw malformed('an unclosed CDATA section')
        if (keepsText && !skipping && stack.length > 0) {
          target.children.push(text.slice(at + 9, close))
        }
        at = close + 3
      } else {
        // <!DOCTYPE ...> and anything else declarative: never needed, never parsed.
        throw dtd(part)
      }
      continue
    }
    if (next === 0x3f /* ? */) {
      const close = text.indexOf('?>', at + 2)
      if (close < 0) throw malformed('an unclosed processing instruction')
      at = close + 2
      continue
    }
    if (next === 0x2f /* / */) {
      const close = text.indexOf('>', at + 2)
      if (close < 0) throw malformed('an unclosed end tag')
      const raw = text.slice(at + 2, close).trim()
      const open = stack.pop()
      if (open?.raw !== raw) throw malformed(`</${raw.slice(0, 40)}> does not match`)
      if (open.scope) scopes.pop()
      if (skipping) skipping--
      const parent = stack.at(-1)
      target = parent ? parent.target : root
      keepsText = parent ? parent.keepsText : !textIn
      at = close + 1
      continue
    }

    // A start tag: its name, then attributes up to > or />.
    let i = at + 1
    while (i < text.length && !isNameEnd(text.charCodeAt(i))) i++
    const raw = text.slice(at + 1, i)
    if (!raw) throw malformed('an empty tag name')
    const attrs: [string, string][] = []
    let selfClosing = false
    for (;;) {
      while (i < text.length && isSpace(text.charCodeAt(i))) i++
      if (i >= text.length) throw malformed('an unclosed start tag')
      const c = text.charCodeAt(i)
      if (c === 0x3e /* > */) {
        i++
        break
      }
      if (c === 0x2f /* / */ && text.charCodeAt(i + 1) === 0x3e) {
        selfClosing = true
        i += 2
        break
      }
      const nameStart = i
      while (i < text.length && !isNameEnd(text.charCodeAt(i)) && text.charCodeAt(i) !== 0x3d) {
        i++
      }
      const name = text.slice(nameStart, i)
      while (i < text.length && isSpace(text.charCodeAt(i))) i++
      if (!name || text.charCodeAt(i) !== 0x3d /* = */) throw malformed('a broken attribute')
      i++
      while (i < text.length && isSpace(text.charCodeAt(i))) i++
      const quote = text[i]
      if (quote !== '"' && quote !== "'") throw malformed('an unquoted attribute')
      const close = text.indexOf(quote, i + 1)
      if (close < 0) throw malformed('an unclosed attribute')
      const value = text.slice(i + 1, close)
      if (value.includes('<')) throw malformed('"<" in an attribute')
      attrs.push([name, value])
      i = close + 1
    }
    at = i

    if (++elements > options.maxElements) {
      throw new DocumentError(
        'too-large',
        `${part} has more than ${String(options.maxElements)} elements; it is too large to read here.`,
      )
    }
    if (stack.length >= options.maxDepth) {
      throw new DocumentError(
        'malformed',
        `${part} is nested more than ${String(options.maxDepth)} levels deep; it was not read.`,
      )
    }
    if (stack.length === 0) {
      if (rooted) throw malformed('more than one root element')
      rooted = true
    }

    let scope: Map<string, string> | null = null
    for (const [name, value] of attrs) {
      if (name === 'xmlns' || name.startsWith('xmlns:')) {
        scope ??= new Map()
        scope.set(name === 'xmlns' ? '' : name.slice(6), decodeEntities(value))
      }
    }
    if (scope) scopes.push(scope)
    let element: XmlElement | null = null
    if (skipping) {
      skipping++
    } else {
      const name = resolve(raw, false)
      const wanted = keep(name)
      if (wanted === 'skip') {
        skipping = 1
      } else if (wanted) {
        element = { name, attrs: {}, children: [] }
        for (const [attr, value] of attrs) {
          if (attr === 'xmlns' || attr.startsWith('xmlns:')) continue
          element.attrs[resolve(attr, true)] = decodeEntities(value)
        }
        target.children.push(element)
      }
    }
    const open: Open = {
      raw,
      element,
      scope,
      target: element ?? target,
      keepsText: element ? !textIn || textIn.has(element.name) : keepsText,
    }
    if (selfClosing) {
      if (scope) scopes.pop()
      if (skipping) skipping--
      continue
    }
    stack.push(open)
    target = open.target
    keepsText = open.keepsText
  }
  if (stack.length > 0) throw malformed(`<${stack.at(-1)?.raw.slice(0, 40) ?? ''}> is not closed`)
  if (!rooted) throw malformed('no root element')
  return root
}

const isSpace = (c: number): boolean => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d
const isNameEnd = (c: number): boolean => isSpace(c) || c === 0x3e || c === 0x2f

/** The first child element with this name, if any. */
export function child(element: XmlElement | undefined, name: string): XmlElement | undefined {
  if (!element) return undefined
  for (const node of element.children) {
    if (typeof node !== 'string' && node.name === name) return node
  }
  return undefined
}

/** The child elements, optionally only those with this name. */
export function elements(element: XmlElement | undefined, name?: string): XmlElement[] {
  if (!element) return []
  const out: XmlElement[] = []
  for (const node of element.children) {
    if (typeof node !== 'string' && (name === undefined || node.name === name)) out.push(node)
  }
  return out
}

/** The first descendant (depth first) with this name, if any. */
export function find(element: XmlElement | undefined, name: string): XmlElement | undefined {
  if (!element) return undefined
  const stack: XmlNode[] = [...element.children].reverse()
  while (stack.length > 0) {
    const node = stack.pop()
    if (node === undefined || typeof node === 'string') continue
    if (node.name === name) return node
    for (let i = node.children.length - 1; i >= 0; i--) {
      const kid = node.children[i]
      if (kid !== undefined) stack.push(kid)
    }
  }
  return undefined
}

/** All the text inside an element, in document order. */
export function textOf(element: XmlElement | undefined): string {
  if (!element) return ''
  let out = ''
  const stack: XmlNode[] = [element]
  while (stack.length > 0) {
    const node = stack.pop()
    if (node === undefined) continue
    if (typeof node === 'string') {
      out += node
      continue
    }
    for (let i = node.children.length - 1; i >= 0; i--) {
      const kid = node.children[i]
      if (kid !== undefined) stack.push(kid)
    }
  }
  return out
}
