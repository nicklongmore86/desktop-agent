import { describe, expect, it } from 'vitest'
import { DocumentError } from './types'
import { decodeEntities, parseXml, refuseDtd, textOf, type XmlElement } from './xml'

const limits = { maxDepth: 64, maxElements: 10_000 }
const parse = (text: string, options: Partial<Parameters<typeof parseXml>[1]> = {}) =>
  parseXml(text, { ...limits, ...options })

function code(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    return error instanceof DocumentError ? `${error.code}: ${error.message}` : String(error)
  }
  return 'parsed'
}

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'

describe('parseXml', () => {
  it('parses elements, attributes, text, entities, CDATA and comments', () => {
    const root = parse(
      '<?xml version="1.0"?><!-- c --><a x="1 &amp; 2" y=\'&#x41;\'>t&lt;1&gt;<b/><![CDATA[<raw>]]>&#65;&nbsp;</a>',
    )
    const a = root.children[0] as XmlElement
    expect(a).toEqual({
      name: 'a',
      attrs: { x: '1 & 2', y: 'A' },
      children: ['t<1>', { name: 'b', attrs: {}, children: [] }, '<raw>', 'A&nbsp;'],
    })
  })

  it('resolves namespaces to their usual prefixes, whatever the file calls them', () => {
    const root = parse(
      `<x:document xmlns:x="${W}" xmlns:q="http://example.com/q"><x:p x:val="1" plain="2"/><q:z/><body xmlns="${W}"><t>hi</t></body></x:document>`,
    )
    const doc = root.children[0] as XmlElement
    expect(doc.name).toBe('w:document')
    expect((doc.children[0] as XmlElement).attrs).toEqual({ 'w:val': '1', plain: '2' })
    expect((doc.children[1] as XmlElement).name).toBe('q:z')
    expect((doc.children[2] as XmlElement).name).toBe('w:body')
    expect(((doc.children[2] as XmlElement).children[0] as XmlElement).name).toBe('w:t')
  })

  it('keeps only the elements and text asked for', () => {
    const root = parse('<r><drop>a<k>b<skip><k>c</k></skip></k>d</drop><k>e</k></r>', {
      keep: (name) => (name === 'skip' ? 'skip' : name === 'k'),
      text: new Set(['k']),
    })
    expect(root.children).toEqual([
      { name: 'k', attrs: {}, children: ['b'] },
      { name: 'k', attrs: {}, children: ['e'] },
    ])
    expect(textOf(root)).toBe('be')
  })

  it('refuses any DTD, so neither external entities nor entity expansion can happen', () => {
    expect(
      code(() => parse('<!DOCTYPE a [<!ENTITY x SYSTEM "file:///etc/passwd">]><a>&x;</a>')),
    ).toMatch(/^malformed: An XML part declares a DTD/)
    expect(code(() => parse('<a><!ENTITY x "y"></a>'))).toMatch(/^malformed: .*DTD/)
    // An undeclared entity is left as written, never looked up.
    expect(textOf(parse('<a>&x;</a>'))).toBe('&x;')
    expect(
      code(() => {
        refuseDtd('<?xml?><!DOCTYPE x><x/>', '"p.xml"')
      }),
    ).toMatch(/^malformed: "p.xml" declares a DTD/)
  })

  it('caps nesting depth and element count', () => {
    const deep = '<a>'.repeat(65) + '</a>'.repeat(65)
    expect(code(() => parse(deep))).toMatch(/^malformed: .*nested more than 64 levels/)
    expect(code(() => parse('<a>'.repeat(64) + '</a>'.repeat(64)))).toBe('parsed')
    const wide = `<a>${'<b/>'.repeat(10_000)}</a>`
    expect(code(() => parse(wide))).toMatch(/^too-large: .*more than 10000 elements/)
    // Skipped elements count too: dropping them is no way around the cap.
    expect(code(() => parse(wide, { keep: (name) => (name === 'a' ? true : 'skip') }))).toMatch(
      /^too-large/,
    )
  })

  it('refuses broken XML', () => {
    for (const bad of [
      '<a>',
      '<a></b>',
      '<a x=1/>',
      '<a x="1/>',
      '<a><!-- x</a>',
      '<a/><b/>',
      'text<a/>',
      '',
      '<a x="<"/>',
    ]) {
      expect(code(() => parse(bad))).toMatch(/^malformed/)
    }
  })

  it('decodes UTF-16 parts with a byte-order mark', () => {
    const text = '﻿<a>ü</a>'
    const bytes = new Uint8Array(text.length * 2)
    for (let i = 0; i < text.length; i++) {
      bytes[i * 2] = text.charCodeAt(i) & 0xff
      bytes[i * 2 + 1] = text.charCodeAt(i) >> 8
    }
    expect(textOf(parseXml(bytes, limits))).toBe('ü')
  })

  it('decodes only valid character references', () => {
    expect(decodeEntities('&#0;&#xD800;&#x110000;&#x1F600;&quot;')).toBe('😀"')
  })

  it('parses a large flat part in linear time', () => {
    const big = `<a>${'<b x="1">text &amp; more</b>'.repeat(200_000)}</a>`
    const started = Date.now()
    const root = parseXml(big, { maxDepth: 8, maxElements: 1_000_000, keep: (n) => n === 'a' })
    expect(root.children).toHaveLength(1)
    expect(Date.now() - started).toBeLessThan(3000)
  })
})
