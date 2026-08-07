import { describe, it, expect } from 'vitest'
import {
  createDocument,
  addPage,
  drawText,
  drawLine,
  drawRect,
  measureText,
  truncate,
  render,
  pageCount,
  onPage,
  FONTS,
  PAGE_SIZES,
} from '../src/posttrade/pdf.js'

function bytes(doc) {
  return render(doc).toString('latin1')
}

describe('pdf document', () => {
  it('renders a parseable single-page document', () => {
    const doc = createDocument()
    drawText(doc, 'Settlement report', 50, 50, { font: FONTS.BOLD, size: 14 })
    const pdf = bytes(doc)

    expect(pdf.startsWith('%PDF-1.4')).toBe(true)
    expect(pdf.trimEnd().endsWith('%%EOF')).toBe(true)
    expect(pdf).toContain('/Type /Catalog')
    expect(pdf).toContain('/Count 1')
    expect(pdf).toContain('(Settlement report) Tj')
  })

  it('points startxref at the actual xref table', () => {
    const doc = createDocument()
    drawText(doc, 'x', 10, 10)
    const pdf = bytes(doc)

    const declared = Number(pdf.match(/startxref\n(\d+)/)[1])
    expect(pdf.slice(declared, declared + 4)).toBe('xref')
  })

  it('records a byte offset for every object', () => {
    const doc = createDocument()
    drawText(doc, 'x', 10, 10)
    const pdf = bytes(doc)

    const table = pdf.slice(pdf.indexOf('xref'), pdf.indexOf('trailer'))
    const entries = table.match(/^\d{10} \d{5} [nf] $/gm)
    // The free entry, plus catalog, page tree, two fonts, the page and its content stream.
    expect(entries).toHaveLength(7)
    for (const entry of entries.slice(1)) {
      const offset = Number(entry.slice(0, 10))
      expect(offset).toBeGreaterThan(0)
      expect(pdf.slice(offset)).toMatch(/^\d+ 0 obj/)
    }
  })

  it('adds pages and counts them', () => {
    const doc = createDocument()
    drawText(doc, 'page one', 50, 50)
    expect(addPage(doc)).toBe(2)
    drawText(doc, 'page two', 50, 50)

    const pdf = bytes(doc)
    expect(pdf).toContain('/Count 2')
    expect(pdf).toContain('(page one) Tj')
    expect(pdf).toContain('(page two) Tj')
  })

  it('draws back onto an earlier page and restores the current one', () => {
    const doc = createDocument()
    drawText(doc, 'first', 50, 50)
    addPage(doc)
    drawText(doc, 'second', 50, 50)

    expect(pageCount(doc)).toBe(2)
    onPage(doc, 0, () => drawText(doc, 'stamped on page one', 50, 700))
    drawText(doc, 'still on page two', 50, 70)

    const pdf = bytes(doc)
    const firstPageOps = pdf.slice(pdf.indexOf('(first)'), pdf.indexOf('(second)'))
    expect(firstPageOps).toContain('(stamped on page one)')
    expect(firstPageOps).not.toContain('(still on page two)')
    expect(pdf.slice(pdf.indexOf('(second)'))).toContain('(still on page two)')
  })

  it('refuses to draw on a page that does not exist', () => {
    const doc = createDocument()
    expect(() => onPage(doc, 5, () => {})).toThrow(/No such page/)
  })

  it('converts top-left coordinates to PDF bottom-left', () => {
    const doc = createDocument({ size: PAGE_SIZES.LETTER })
    drawText(doc, 'x', 100, 92)
    // 792 - 92 = 700 up from the bottom.
    expect(bytes(doc)).toContain('100 700 Td')
  })

  it('escapes the characters that would end a PDF string early', () => {
    const doc = createDocument()
    drawText(doc, 'Fee (net) 50% \\ done', 50, 50)
    expect(bytes(doc)).toContain('(Fee \\(net\\) 50% \\\\ done) Tj')
  })

  it('replaces typographic characters the core fonts cannot render', () => {
    const doc = createDocument()
    drawText(doc, 'T+1 — “settled” … ok', 50, 50)
    expect(bytes(doc)).toContain('(T+1 - "settled" ... ok) Tj')
  })

  it('draws rules and filled rectangles', () => {
    const doc = createDocument()
    drawLine(doc, 50, 100, 550, 100, { width: 1 })
    drawRect(doc, 50, 110, 500, 14, { color: [0.92, 0.92, 0.92] })

    const pdf = bytes(doc)
    expect(pdf).toContain('50 692 m 550 692 l S')
    expect(pdf).toContain('re f')
  })
})

describe('text measurement', () => {
  it('measures against the real font metrics', () => {
    // 'i' is narrow, 'W' is wide — a fixed-width guess would call these equal.
    expect(measureText('i', FONTS.REGULAR, 10)).toBeCloseTo(2.22, 2)
    expect(measureText('W', FONTS.REGULAR, 10)).toBeCloseTo(9.44, 2)
    expect(measureText('', FONTS.REGULAR, 10)).toBe(0)
  })

  it('scales linearly with font size', () => {
    expect(measureText('Settlement', FONTS.REGULAR, 20)).toBeCloseTo(
      measureText('Settlement', FONTS.REGULAR, 10) * 2,
      5,
    )
  })

  it('measures bold wider than regular', () => {
    expect(measureText('Settlement', FONTS.BOLD, 10)).toBeGreaterThan(
      measureText('Settlement', FONTS.REGULAR, 10),
    )
  })

  it('truncates to fit rather than overflowing the column', () => {
    const long = 'Meridian Clearing Partners LLC'
    const fitted = truncate(long, FONTS.REGULAR, 9, 60)
    expect(fitted.endsWith('...')).toBe(true)
    expect(measureText(fitted, FONTS.REGULAR, 9)).toBeLessThanOrEqual(60)
    expect(truncate('short', FONTS.REGULAR, 9, 60)).toBe('short')
  })

  it('truncates through drawText when a maxWidth is given', () => {
    const doc = createDocument()
    drawText(doc, 'Meridian Clearing Partners LLC', 50, 50, { maxWidth: 40 })
    expect(bytes(doc)).toMatch(/\(Meri[a-zA-Z ]*\.\.\.\) Tj/)
  })
})

describe('alignment', () => {
  it('right-aligns against the given x', () => {
    const doc = createDocument()
    const width = measureText('1,234.56', FONTS.REGULAR, 9)
    drawText(doc, '1,234.56', 500, 100, { align: 'right' })
    expect(bytes(doc)).toContain(`${Number((500 - width).toFixed(2))} 692 Td`)
  })

  it('centres on the given x', () => {
    const doc = createDocument()
    const width = measureText('TITLE', FONTS.BOLD, 12)
    drawText(doc, 'TITLE', 306, 100, { font: FONTS.BOLD, size: 12, align: 'center' })
    expect(bytes(doc)).toContain(`${Number((306 - width / 2).toFixed(2))} 692 Td`)
  })
})
