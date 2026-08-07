/**
 * A minimal PDF writer — text, rules and filled rectangles, and nothing else.
 *
 * Written by hand rather than pulled in as a dependency, for the same reason the frontend
 * draws its own SVG charts: a settlement report is a fixed layout of text and lines, and a
 * general-purpose PDF library is a large, transitively-deep dependency to carry into a
 * regulated data path for that. Everything here is the PDF 1.4 core — two standard Type 1
 * fonts (no embedding, no licensing question), one content stream per page, an accurate
 * cross-reference table.
 *
 * Two conveniences the raw format does not give you:
 *
 *  - **Top-left coordinates.** PDF measures Y up from the bottom of the page; every report
 *    layout in existence measures down from the top. The conversion happens here, once,
 *    so the report module never thinks about it.
 *  - **Real text measurement.** The Helvetica and Helvetica-Bold advance widths are
 *    included, so text can be centred, right-aligned against a column edge, or truncated
 *    to fit — a settlement amount that silently overlaps the column beside it is a
 *    misleading document, not a cosmetic bug.
 */

export const PAGE_SIZES = {
  LETTER: { width: 612, height: 792 },
  A4: { width: 595.28, height: 841.89 },
}

export const FONTS = {
  REGULAR: 'F1', // Helvetica
  BOLD: 'F2', // Helvetica-Bold
}

/** Open a document. Starts with one blank page. */
export function createDocument({ size = PAGE_SIZES.LETTER } = {}) {
  const doc = { width: size.width, height: size.height, pages: [], activePage: 0 }
  addPage(doc)
  return doc
}

/** Start a new page and make it current. */
export function addPage(doc) {
  doc.pages.push({ ops: [] })
  doc.activePage = doc.pages.length - 1
  return doc.pages.length
}

/** Number of pages so far. */
export function pageCount(doc) {
  return doc.pages.length
}

/**
 * Draw onto an earlier page, then restore the page that was current.
 *
 * Needed for anything that can only be written once the document is finished — a "page 2
 * of 7" footer cannot know the 7 until the last page exists.
 */
export function onPage(doc, index, draw) {
  if (index < 0 || index >= doc.pages.length) {
    throw new Error(`No such page: ${index}`)
  }
  const previous = doc.activePage
  doc.activePage = index
  try {
    draw()
  } finally {
    doc.activePage = previous
  }
}

function current(doc) {
  return doc.pages[doc.activePage]
}

/**
 * Draw text at (x, y) measured from the top-left of the page.
 *
 * `align` positions the string relative to x: 'left' (default), 'right' or 'center'.
 * `maxWidth` truncates with an ellipsis rather than letting the text run into whatever is
 * drawn beside it.
 */
export function drawText(doc, text, x, y, options = {}) {
  const {
    font = FONTS.REGULAR,
    size = 9,
    color = [0, 0, 0],
    align = 'left',
    maxWidth = null,
  } = options

  let value = sanitize(text)
  if (maxWidth != null) value = truncate(value, font, size, maxWidth)

  const width = measureText(value, font, size)
  const drawX = align === 'right' ? x - width : align === 'center' ? x - width / 2 : x
  const drawY = doc.height - y

  current(doc).ops.push(
    `BT /${font} ${fmt(size)} Tf ${rgb(color)} rg ${fmt(drawX)} ${fmt(drawY)} Td (${escapeText(value)}) Tj ET`,
  )
  return width
}

/** A horizontal or diagonal rule, coordinates from the top-left. */
export function drawLine(doc, x1, y1, x2, y2, { width = 0.5, color = [0, 0, 0] } = {}) {
  current(doc).ops.push(
    `${rgb(color)} RG ${fmt(width)} w ${fmt(x1)} ${fmt(doc.height - y1)} m ${fmt(x2)} ${fmt(doc.height - y2)} l S`,
  )
}

/** A filled rectangle — table header shading, status chips, rule bars. */
export function drawRect(doc, x, y, width, height, { color = [0.9, 0.9, 0.9] } = {}) {
  current(doc).ops.push(
    `${rgb(color)} rg ${fmt(x)} ${fmt(doc.height - y - height)} ${fmt(width)} ${fmt(height)} re f`,
  )
}

/** Width of a string in points at a given font and size. */
export function measureText(text, font = FONTS.REGULAR, size = 9) {
  const widths = font === FONTS.BOLD ? HELVETICA_BOLD_WIDTHS : HELVETICA_WIDTHS
  let total = 0
  for (const char of sanitize(text)) {
    const code = char.charCodeAt(0)
    total += widths[code - 32] ?? 556
  }
  return (total * size) / 1000
}

/** Shorten a string with a trailing ellipsis until it fits the given width. */
export function truncate(text, font, size, maxWidth) {
  const value = sanitize(text)
  if (measureText(value, font, size) <= maxWidth) return value

  let cut = value
  while (cut.length > 1 && measureText(`${cut}...`, font, size) > maxWidth) {
    cut = cut.slice(0, -1)
  }
  return `${cut}...`
}

/** Serialize the document to a Buffer of PDF bytes. */
export function render(doc) {
  const objects = []
  const pageCount = doc.pages.length

  // Object 1 is the catalog and 2 the page tree; fonts take 3 and 4; each page then uses
  // two objects (the page and its content stream), which makes the ids predictable.
  const pageObjectId = (index) => 5 + index * 2
  const contentObjectId = (index) => 6 + index * 2

  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'

  const kids = doc.pages.map((_, index) => `${pageObjectId(index)} 0 R`).join(' ')
  objects[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'
  objects[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'

  doc.pages.forEach((page, index) => {
    objects[pageObjectId(index)] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${fmt(doc.width)} ${fmt(doc.height)}] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentObjectId(index)} 0 R >>`

    const stream = page.ops.join('\n')
    objects[contentObjectId(index)] =
      `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`
  })

  const chunks = []
  const offsets = []
  let position = 0

  const push = (text) => {
    const buffer = Buffer.from(text, 'latin1')
    chunks.push(buffer)
    position += buffer.length
  }

  push('%PDF-1.4\n')
  // A binary comment marks the file as containing binary data, so tools transferring it
  // do not "helpfully" translate line endings.
  push('%\xE2\xE3\xCF\xD3\n')

  for (let id = 1; id < objects.length; id++) {
    if (objects[id] == null) continue
    offsets[id] = position
    push(`${id} 0 obj\n${objects[id]}\nendobj\n`)
  }

  const xrefOffset = position
  const maxId = objects.length
  push(`xref\n0 ${maxId}\n`)
  push('0000000000 65535 f \n')
  for (let id = 1; id < maxId; id++) {
    push(`${String(offsets[id] ?? 0).padStart(10, '0')} 00000 n \n`)
  }
  push(`trailer\n<< /Size ${maxId} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`)

  return Buffer.concat(chunks)
}

/**
 * Drop characters the standard fonts cannot render.
 *
 * WinAnsi covers Latin-1, so an em dash or a curly quote pasted into a narrative would
 * otherwise emit a byte the viewer draws as garbage. Replacing the handful of typographic
 * characters that actually turn up and stripping the rest keeps the document legible.
 */
function sanitize(text) {
  return String(text ?? '')
    .replace(/[–—]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, '...')
    .replace(/[^\x20-\x7E]/g, '')
}

/** Backslash, parenthesis: the three characters that would end a PDF string early. */
function escapeText(text) {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
}

function rgb([r, g, b]) {
  return `${fmt(r)} ${fmt(g)} ${fmt(b)}`
}

/** Two decimals is a hundredth of a point — well below anything visible, and keeps the
 *  content stream small and byte-stable between runs. */
function fmt(value) {
  return Number(value.toFixed(2)).toString()
}

// Advance widths in 1/1000 em for ASCII 32-126, from the Adobe core font metrics.
const HELVETICA_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667,
  611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
  667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500,
  222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
]

const HELVETICA_BOLD_WIDTHS = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667,
  611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
  667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556,
  278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
]
