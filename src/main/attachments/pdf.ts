// A cheap, best-effort PDF page count, with no PDF parser. The page tree's
// `/Type /Pages ... /Count N` is read where it is stored as plain text, which is
// the case for most PDFs up to 1.4 and many later ones. Files that keep it in a
// compressed object stream give null, and only the size limit applies to them.

// Bounded gaps keep a hostile file from making the scan quadratic.
const PAGES_DICT =
  /\/Type\s*\/Pages\b[^>]{0,2000}?\/Count\s+(\d+)|\/Count\s+(\d+)[^>]{0,2000}?\/Type\s*\/Pages\b/g

/** The document's page count (the largest `/Pages` `/Count`, i.e. the root), or null if unknown. */
export function pdfPageCount(bytes: Buffer): number | null {
  const text = bytes.toString('latin1')
  let best: number | null = null
  for (const match of text.matchAll(PAGES_DICT)) {
    const count = Number(match[1] ?? match[2])
    if (Number.isSafeInteger(count) && (best === null || count > best)) best = count
  }
  return best
}
