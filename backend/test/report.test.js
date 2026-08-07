import { describe, it, expect } from 'vitest'
import { runSettlementProcedure } from '../src/posttrade/procedure.js'
import { renderSettlementReport, TABLE_COLUMNS, LAYOUT } from '../src/posttrade/report.js'
import { measureText, FONTS } from '../src/posttrade/pdf.js'

const FILLS = [
  { ts: '2025-03-05T14:30:00.000Z', side: 'BUY', qty: 500, price: 50.25 },
  { ts: '2025-03-06T14:30:00.000Z', side: 'SELL', qty: 200, price: 52.5 },
  { ts: '2025-03-07T14:30:00.000Z', side: 'SELL', qty: 300, price: 49.8 },
]

function procedure(overrides = {}) {
  return runSettlementProcedure({
    symbol: 'AAPL',
    fills: FILLS,
    startingCash: 100000,
    valuationDate: '2025-03-12',
    generatedAt: '2025-03-12T22:00:00.000Z',
    ...overrides,
  })
}

/** The rendered PDF as a searchable string. Content streams are uncompressed by design. */
function text(result) {
  return renderSettlementReport(result).toString('latin1')
}

/** Parentheses delimit a PDF string, so drawn text carries them escaped. */
function drawn(value) {
  return `(${value.replace(/[()]/g, (char) => `\\${char}`)})`
}

describe('report layout', () => {
  it('keeps every table inside the printable width', () => {
    for (const [name, columns] of Object.entries(TABLE_COLUMNS)) {
      const total = columns.reduce((sum, column) => sum + column.width, 0)
      expect(`${name}: ${total}`).toBe(`${name}: ${Math.min(total, LAYOUT.CONTENT_WIDTH)}`)
    }
  })

  it('leaves every column header room for its own label', () => {
    // A heading that does not fit its column is truncated to "Settleme..." — legible but
    // not what anyone intended, and a sign the width was guessed.
    for (const columns of Object.values(TABLE_COLUMNS)) {
      for (const column of columns) {
        expect(measureText(column.label, FONTS.BOLD, 7.5)).toBeLessThanOrEqual(column.width - 6)
      }
    }
  })
})

describe('renderSettlementReport', () => {
  it('renders a valid PDF', () => {
    const pdf = renderSettlementReport(procedure())
    expect(Buffer.isBuffer(pdf)).toBe(true)
    expect(pdf.toString('latin1', 0, 8)).toBe('%PDF-1.4')
    expect(pdf.toString('latin1').trimEnd().endsWith('%%EOF')).toBe(true)
  })

  it('is reproducible — the same run renders byte-identical bytes', () => {
    expect(renderSettlementReport(procedure()).equals(renderSettlementReport(procedure()))).toBe(true)
  })

  it('carries the header, run identity and entity', () => {
    const pdf = text(procedure())
    expect(pdf).toContain('(Daily Settlement Report)')
    expect(pdf).toContain('(STP Platform Securities LLC)')
    expect(pdf).toMatch(/Run: STL-AAPL-20250312/)
  })

  it('states the straight-through rate and control outcomes', () => {
    const pdf = text(procedure())
    expect(pdf).toContain('(100.0%)')
    expect(pdf).toContain('(Straight-through rate)')
    expect(pdf).toContain('(Books in balance)')
    expect(pdf).toContain('(Custodian reconciled)')
  })

  it('renders every lifecycle stage', () => {
    const pdf = text(procedure())
    for (const stage of ['Trade capture', 'Enrichment', 'Confirmation matching', 'Settlement (DVP)', 'Custodian reconciliation']) {
      expect(pdf).toContain(drawn(stage))
    }
  })

  it('renders the blotter with each trade and its settlement status', () => {
    const pdf = text(procedure())
    expect(pdf).toContain('(TRD-AAPL-0001)')
    expect(pdf).toContain('(TRD-AAPL-0003)')
    expect(pdf).toContain('(SETTLED)')
  })

  it('renders the cash ledger with a running balance that ties to the summary', () => {
    const result = procedure()
    const pdf = text(result)
    expect(pdf).toContain('(Cash ledger - 1000 Cash at custodian)')
    expect(pdf).toContain('(Opening cash balance)')
    expect(pdf).toContain('(Closing cash balance)')
    // 100,309.21 closing — the figure appears in the ledger and again in the summary.
    const closing = '100,309.21'
    expect(result.summary.closingCashCents).toBe(10030921)
    expect(pdf.split(`(${closing})`).length - 1).toBeGreaterThanOrEqual(2)
  })

  it('renders the trial balance and states that it balances', () => {
    const pdf = text(procedure())
    expect(pdf).toContain('(Trial balance)')
    expect(pdf).toContain('(Totals - in balance)')
    expect(pdf).toContain('(Cash at custodian)')
    expect(pdf).toContain('(Realised trading P&L)')
  })

  it('says so plainly when there is nothing to report in a section', () => {
    const pdf = text(procedure())
    expect(pdf).toContain('(No fails - every instructed trade settled on its due date.)')
    expect(pdf).toContain('(None - the batch processed straight through.)')
    expect(pdf).toContain('(Flat - no open positions at the close of the value date.)')
  })

  it('numbers every page and stamps its provenance', () => {
    const pdf = text(procedure())
    const stamps = pdf.match(/\(Page \d+ of (\d+)\)/g)
    expect(stamps.length).toBeGreaterThan(1)
    const total = Number(stamps[0].match(/of (\d+)/)[1])
    expect(stamps).toHaveLength(total)
    expect(pdf).toContain('system-generated by the Settlement Agent')
    expect(pdf).toContain('not a client confirmation')
  })

  it('signs off clean when nothing needs a human', () => {
    expect(text(procedure())).toContain('(Processed straight through. No manual intervention was required and no items are outstanding.)')
  })

  it('requires a procedure result', () => {
    expect(() => renderSettlementReport(null)).toThrow(/requires a settlement procedure result/)
    expect(() => renderSettlementReport({})).toThrow(/requires a settlement procedure result/)
  })
})

describe('reporting the bad day', () => {
  const messy = () =>
    procedure({
      fills: [...FILLS, { ts: '2025-03-07T15:00:00.000Z', side: 'BUY', qty: 1.5, price: 10 }],
      confirmDiscrepancies: { 'TRD-AAPL-0002': { qty: 100 } },
      failedTradeIds: ['TRD-AAPL-0003'],
      custodianDiscrepancies: { cashDeltaCents: 250 },
    })

  it('reports the degraded straight-through rate rather than the happy one', () => {
    const pdf = text(messy())
    expect(pdf).toContain('(25.0%)')
    expect(pdf).toContain('(1 / 4)')
  })

  it('lists the fail with its age and the action it triggers', () => {
    const pdf = text(messy())
    expect(pdf).toContain('(TRD-AAPL-0003)')
    expect(pdf).toContain('(ESCALATE TO OPS)')
  })

  it('lists exceptions from every stage', () => {
    const pdf = text(messy())
    expect(pdf).toContain('(RPR-AAPL-0004)')
    expect(pdf).toContain('(MTC-TRD-AAPL-0002)')
    expect(pdf).toContain('(REC-CASH)')
  })

  it('shows the custodian break on both sides of the comparison', () => {
    const pdf = text(messy())
    expect(pdf).toContain('(BREAK)')
    expect(pdf).toContain('(74,872.50)')
    expect(pdf).toContain('(74,875.00)')
  })

  it('withholds a clean sign-off and says what has to be reviewed', () => {
    const pdf = text(messy())
    expect(pdf).not.toContain('(Processed straight through.')
    expect(pdf).toContain(
      drawn('Processed with 4 exception(s) and 1 fail(s) requiring review before sign-off.'),
    )
  })

  it('still balances the books and says so — a break is not a broken ledger', () => {
    const result = messy()
    expect(result.summary.inBalance).toBe(true)
    expect(text(result)).toContain('(Totals - in balance)')
  })
})
