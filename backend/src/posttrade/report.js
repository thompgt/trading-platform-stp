/**
 * The settlement report — the procedure's output as a document a human can sign.
 *
 * Everything in here is a rendering of `runSettlementProcedure`'s result. It computes
 * nothing: if a number is on the page, it came off the ledger or the summary, and if the
 * books did not balance the report says so rather than quietly presenting a total. A
 * report that can disagree with the system it reports on is worse than no report.
 *
 * The layout is the one an operations pack actually has:
 *
 *   1. Header and control summary — did it work, and is anything on fire
 *   2. Lifecycle — what each stage was handed and what came out of it
 *   3. Trade blotter — every trade with its economics and settlement status
 *   4. Cash ledger — the movement of actual money, with a running balance
 *   5. Trial balance — proof the books balance
 *   6. Exceptions, fails and reconciliation — what a human has to look at
 *   7. Sign-off block — automated up to here, a person from here
 *
 * Sections stay in that order because it is descending order of "what would make me stop
 * reading and pick up the phone".
 */
import {
  createDocument,
  addPage,
  drawText,
  drawLine,
  drawRect,
  measureText,
  render,
  onPage,
  pageCount,
  FONTS,
  PAGE_SIZES,
} from './pdf.js'
import { formatCents } from './money.js'

const MARGIN = 46
const CONTENT_WIDTH = PAGE_SIZES.LETTER.width - MARGIN * 2
const BOTTOM_LIMIT = PAGE_SIZES.LETTER.height - 58 // leaves room for the footer

const INK = [0.1, 0.1, 0.12]
const MUTED = [0.42, 0.44, 0.5]
const RULE = [0.78, 0.79, 0.82]
const HEADER_FILL = [0.93, 0.94, 0.96]
const GOOD = [0.05, 0.45, 0.25]
const WARN = [0.72, 0.45, 0.03]
const BAD = [0.7, 0.13, 0.13]

/**
 * Column definitions for every table in the report.
 *
 * Declared here rather than inline at each call site so the widths can be asserted against
 * the content width in a test. A table whose columns sum past the right margin still
 * *renders* — it just quietly writes the last column into the page edge — so this is the
 * kind of mistake that reaches production looking fine on the developer's first sample and
 * wrong on the first wide one.
 */
export const TABLE_COLUMNS = {
  lifecycle: [
    { key: 'name', label: 'Stage', width: 150 },
    { key: 'desk', label: 'Function', width: 90 },
    { key: 'in', label: 'In', width: 50, align: 'right' },
    { key: 'out', label: 'Out', width: 50, align: 'right' },
    { key: 'exceptions', label: 'Exceptions', width: 70, align: 'right' },
    { key: 'status', label: 'Status', width: 110, align: 'right' },
  ],
  blotter: [
    { key: 'tradeId', label: 'Trade', width: 86 },
    { key: 'tradeDate', label: 'Trade dt', width: 52 },
    { key: 'settlementDate', label: 'Settle dt', width: 52 },
    { key: 'side', label: 'Side', width: 28 },
    { key: 'qty', label: 'Qty', width: 38, align: 'right' },
    { key: 'price', label: 'Price', width: 44, align: 'right' },
    { key: 'gross', label: 'Gross', width: 62, align: 'right' },
    { key: 'fees', label: 'Fees', width: 40, align: 'right' },
    { key: 'net', label: 'Net', width: 62, align: 'right' },
    { key: 'settlementStatus', label: 'Status', width: 56, align: 'right' },
  ],
  cashLedger: [
    { key: 'date', label: 'Date', width: 52 },
    { key: 'entryId', label: 'Entry', width: 52 },
    { key: 'reference', label: 'Reference', width: 88 },
    { key: 'narrative', label: 'Narrative', width: 130 },
    { key: 'debit', label: 'Debit', width: 64, align: 'right' },
    { key: 'credit', label: 'Credit', width: 64, align: 'right' },
    { key: 'balance', label: 'Balance', width: 70, align: 'right' },
  ],
  trialBalance: [
    { key: 'code', label: 'Code', width: 44 },
    { key: 'name', label: 'Account', width: 186 },
    { key: 'type', label: 'Type', width: 66 },
    { key: 'debits', label: 'Debits', width: 74, align: 'right' },
    { key: 'credits', label: 'Credits', width: 74, align: 'right' },
    { key: 'balance', label: 'Balance', width: 76, align: 'right' },
  ],
  positions: [
    { key: 'symbol', label: 'Symbol', width: 80 },
    { key: 'qty', label: 'Quantity', width: 80, align: 'right' },
    { key: 'averageCost', label: 'Average cost', width: 100, align: 'right' },
    { key: 'cost', label: 'Total cost', width: 100, align: 'right' },
  ],
  fails: [
    { key: 'tradeId', label: 'Trade', width: 92 },
    { key: 'settlementDate', label: 'Due', width: 58 },
    { key: 'age', label: 'Age (bd)', width: 50, align: 'right' },
    { key: 'amount', label: 'Amount', width: 80, align: 'right' },
    { key: 'action', label: 'Action', width: 90 },
    { key: 'severity', label: 'Severity', width: 60, align: 'right' },
  ],
  exceptions: [
    { key: 'id', label: 'Reference', width: 104 },
    { key: 'stage', label: 'Stage', width: 74 },
    { key: 'severity', label: 'Severity', width: 48 },
    { key: 'message', label: 'Detail', width: 294 },
  ],
  reconciliation: [
    { key: 'line', label: 'Line', width: 130 },
    { key: 'internal', label: 'Our books', width: 110, align: 'right' },
    { key: 'custodian', label: 'Custodian', width: 110, align: 'right' },
    { key: 'delta', label: 'Difference', width: 100, align: 'right' },
    { key: 'status', label: 'Status', width: 70, align: 'right' },
  ],
}

/**
 * Render a procedure result to PDF bytes.
 *
 * Returns a Buffer, so the caller can stream it, write it, or hash it — the API route does
 * the first, tests do the last.
 */
export function renderSettlementReport(result) {
  if (!result || !result.summary) {
    throw new Error('renderSettlementReport requires a settlement procedure result')
  }

  const doc = createDocument({ size: PAGE_SIZES.LETTER })
  const ctx = { doc, y: MARGIN }

  drawReportHeader(ctx, result)
  drawControlSummary(ctx, result)
  drawLifecycle(ctx, result)
  drawBlotter(ctx, result)
  drawCashLedger(ctx, result)
  drawTrialBalance(ctx, result)
  drawPositions(ctx, result)
  drawFails(ctx, result)
  drawExceptions(ctx, result)
  drawReconciliation(ctx, result)
  drawSignOff(ctx, result)
  drawFooters(doc, result)

  return render(doc)
}

// --- sections -----------------------------------------------------------------------

function drawReportHeader(ctx, result) {
  const { doc } = ctx
  drawText(doc, result.entity.legalEntity, MARGIN, ctx.y + 9, { font: FONTS.BOLD, size: 11, color: INK })
  drawText(doc, `LEI ${result.entity.lei}`, MARGIN + CONTENT_WIDTH, ctx.y + 9, {
    size: 7.5,
    color: MUTED,
    align: 'right',
  })
  ctx.y += 20

  drawText(doc, 'Daily Settlement Report', MARGIN, ctx.y + 13, { font: FONTS.BOLD, size: 17, color: INK })
  ctx.y += 22

  const meta = [
    ['Run', result.runId],
    ['Symbol', result.symbol],
    ['Value date', result.valuationDate ?? 'n/a'],
    ['Account', result.parameters.account],
    ['Generated', result.generatedAt],
  ]
  const line = meta.map(([label, value]) => `${label}: ${value}`).join('   ·   ')
  drawText(doc, line, MARGIN, ctx.y + 8, { size: 8, color: MUTED, maxWidth: CONTENT_WIDTH })
  ctx.y += 14

  drawLine(doc, MARGIN, ctx.y, MARGIN + CONTENT_WIDTH, ctx.y, { width: 1, color: INK })
  ctx.y += 16
}

/**
 * The block someone reads in five seconds: did it go straight through, do the books
 * balance, does the custodian agree, and how many items need a person.
 */
function drawControlSummary(ctx, result) {
  const { doc } = ctx
  const { summary } = result

  sectionTitle(ctx, 'Control summary')

  const stp = summary.stpRatePct
  const tiles = [
    {
      label: 'Straight-through rate',
      value: `${stp.toFixed(1)}%`,
      color: stp === 100 ? GOOD : stp >= 90 ? WARN : BAD,
    },
    {
      label: 'Settled / captured',
      value: `${summary.settledCount} / ${summary.capturedCount}`,
      color: INK,
    },
    {
      label: 'Books in balance',
      value: summary.inBalance ? 'YES' : 'NO',
      color: summary.inBalance ? GOOD : BAD,
    },
    {
      label: 'Custodian reconciled',
      value: summary.reconciled ? 'YES' : 'NO',
      color: summary.reconciled ? GOOD : BAD,
    },
    {
      label: 'Items for review',
      value: String(summary.exceptionCount + summary.failsCount),
      color: summary.exceptionCount + summary.failsCount === 0 ? GOOD : WARN,
    },
  ]

  const tileWidth = CONTENT_WIDTH / tiles.length
  drawRect(doc, MARGIN, ctx.y, CONTENT_WIDTH, 38, { color: HEADER_FILL })
  tiles.forEach((tile, index) => {
    const centre = MARGIN + tileWidth * index + tileWidth / 2
    drawText(doc, tile.value, centre, ctx.y + 17, {
      font: FONTS.BOLD,
      size: 13,
      color: tile.color,
      align: 'center',
    })
    drawText(doc, tile.label, centre, ctx.y + 30, {
      size: 7,
      color: MUTED,
      align: 'center',
      maxWidth: tileWidth - 6,
    })
  })
  ctx.y += 44

  // The rate is not a standalone number: it is the share settled *as at a date*, and
  // trades whose settlement date has not arrived are pending rather than broken. Printing
  // the as-of date under the tiles stops the headline being read as a timeless score.
  drawText(
    doc,
    `Straight-through rate measured as at ${summary.stpRateAsOf ?? result.valuationDate ?? 'n/a'}; trades settling after that date are still pending, not exceptions.`,
    MARGIN,
    ctx.y + 7,
    { size: 7, color: MUTED, maxWidth: CONTENT_WIDTH },
  )
  ctx.y += 12

  // The money, on one line each, in the order an ops reviewer checks them.
  const figures = [
    ['Gross traded (settled)', formatCents(summary.grossCents)],
    ['Commission and fees', formatCents(summary.feesCents)],
    ['Net cash movement', formatCents(summary.netCashMovementCents)],
    ['Realised P&L', formatCents(summary.realisedPnlCents)],
    ['Closing cash', formatCents(summary.closingCashCents)],
    ['Open receivable / payable', `${formatCents(summary.openReceivableCents)} / ${formatCents(summary.openPayableCents)}`],
  ]
  drawKeyValues(ctx, figures)
  ctx.y += 6
}

function drawLifecycle(ctx, result) {
  sectionTitle(ctx, 'Trade lifecycle')
  drawTable(ctx, {
    columns: TABLE_COLUMNS.lifecycle,
    rows: result.stages.map((stage) => ({
      ...stage,
      _color: { status: stage.status === 'CLEAN' ? GOOD : WARN },
    })),
  })
}

function drawBlotter(ctx, result) {
  sectionTitle(ctx, 'Trade blotter')

  if (result.trades.length === 0) {
    emptyNote(ctx, 'No trades were captured for this value date.')
    return
  }

  drawTable(ctx, {
    columns: TABLE_COLUMNS.blotter,
    rows: result.trades.map((trade) => ({
      tradeId: trade.tradeId,
      tradeDate: trade.tradeDate,
      settlementDate: trade.settlementDate,
      side: trade.side,
      qty: trade.qty,
      price: trade.price.toFixed(2),
      gross: formatCents(trade.grossCents),
      fees: formatCents(trade.totalFeesCents),
      net: formatCents(trade.netAmountCents),
      settlementStatus: trade.settlementStatus,
      _color: { settlementStatus: statusColour(trade.settlementStatus) },
    })),
  })
}

/** The cash ledger — the section this whole report exists to carry. */
function drawCashLedger(ctx, result) {
  const cash = result.ledger.cash
  sectionTitle(ctx, `Cash ledger — ${cash.account.code} ${cash.account.name}`)

  if (cash.lines.length === 0) {
    emptyNote(ctx, 'No cash movements posted.')
    return
  }

  drawTable(ctx, {
    columns: TABLE_COLUMNS.cashLedger,
    rows: cash.lines.map((line) => ({
      date: line.date ?? '',
      entryId: line.entryId,
      reference: line.reference ?? line.tradeId ?? '',
      narrative: line.narrative,
      debit: line.debitCents === 0 ? '' : formatCents(line.debitCents),
      credit: line.creditCents === 0 ? '' : formatCents(line.creditCents),
      balance: formatCents(line.balanceCents),
    })),
    total: {
      narrative: 'Closing cash balance',
      balance: formatCents(cash.closingBalanceCents),
    },
  })
}

function drawTrialBalance(ctx, result) {
  const tb = result.ledger.trialBalance
  sectionTitle(ctx, 'Trial balance')

  drawTable(ctx, {
    columns: TABLE_COLUMNS.trialBalance,
    rows: tb.rows.map((row) => ({
      code: row.code,
      name: row.name,
      type: row.type,
      debits: formatCents(row.debitsCents),
      credits: formatCents(row.creditsCents),
      balance: formatCents(row.balanceCents),
    })),
    total: {
      name: tb.inBalance ? 'Totals — in balance' : 'Totals — OUT OF BALANCE',
      debits: formatCents(tb.totalDebitsCents),
      credits: formatCents(tb.totalCreditsCents),
      _color: { name: tb.inBalance ? INK : BAD },
    },
  })
}

function drawPositions(ctx, result) {
  sectionTitle(ctx, 'Open positions')

  if (result.positions.length === 0) {
    emptyNote(ctx, 'Flat — no open positions at the close of the value date.')
    return
  }

  drawTable(ctx, {
    columns: TABLE_COLUMNS.positions,
    rows: result.positions.map((position) => ({
      symbol: position.symbol,
      qty: position.qty,
      averageCost: formatCents(position.averageCostCents),
      cost: formatCents(position.costCents),
    })),
  })
}

function drawFails(ctx, result) {
  sectionTitle(ctx, 'Settlement fails')

  if (result.fails.length === 0) {
    emptyNote(ctx, 'No fails — every instructed trade settled on its due date.')
    return
  }

  drawTable(ctx, {
    columns: TABLE_COLUMNS.fails,
    rows: result.fails.map((fail) => ({
      tradeId: fail.tradeId,
      settlementDate: fail.settlementDate,
      age: fail.ageBusinessDays,
      amount: formatCents(fail.amountCents),
      action: fail.action.replace(/_/g, ' '),
      severity: fail.severity.toUpperCase(),
      _color: { severity: severityColour(fail.severity) },
    })),
  })
}

function drawExceptions(ctx, result) {
  sectionTitle(ctx, 'Exceptions for review')

  if (result.exceptions.length === 0) {
    emptyNote(ctx, 'None — the batch processed straight through.')
    return
  }

  drawTable(ctx, {
    columns: TABLE_COLUMNS.exceptions,
    rows: result.exceptions.map((exception) => ({
      id: exception.id,
      stage: exception.stage,
      severity: (exception.severity ?? 'high').toUpperCase(),
      message: exception.message ?? exception.reason ?? '',
      _color: { severity: severityColour(exception.severity ?? 'high') },
    })),
  })
}

function drawReconciliation(ctx, result) {
  const recon = result.reconciliation
  sectionTitle(ctx, 'Custodian reconciliation')

  drawKeyValues(ctx, [
    ['Custodian', recon.custodian],
    ['Statement', recon.statementId],
    ['Lines checked', String(recon.linesChecked)],
    ['Result', recon.reconciled ? 'Reconciled — no breaks' : `${recon.breaks.length} break(s) outstanding`],
  ])
  ctx.y += 4

  drawTable(ctx, {
    columns: TABLE_COLUMNS.reconciliation,
    rows: [
      {
        line: 'Cash',
        internal: formatCents(recon.cash.internalCents),
        custodian: formatCents(recon.cash.custodianCents),
        delta: formatCents(recon.cash.deltaCents),
        status: recon.cash.status,
        _color: { status: recon.cash.status === 'MATCHED' ? GOOD : BAD },
      },
      ...recon.positions.map((position) => ({
        line: `Position ${position.symbol}`,
        internal: `${position.internalQty}`,
        custodian: `${position.custodianQty}`,
        delta: `${position.deltaQty}`,
        status: position.status,
        _color: { status: position.status === 'MATCHED' ? GOOD : BAD },
      })),
    ],
  })
}

function drawSignOff(ctx, result) {
  const { summary } = result
  const clean = summary.inBalance && summary.reconciled && summary.exceptionCount === 0 && summary.failsCount === 0

  ensureSpace(ctx, 74)
  sectionTitle(ctx, 'Sign-off')

  const verdict = clean
    ? 'Processed straight through. No manual intervention was required and no items are outstanding.'
    : `Processed with ${summary.exceptionCount} exception(s) and ${summary.failsCount} fail(s) requiring review before sign-off.`

  drawText(ctx.doc, verdict, MARGIN, ctx.y + 8, {
    size: 8.5,
    color: clean ? INK : BAD,
    maxWidth: CONTENT_WIDTH,
  })
  ctx.y += 22

  const boxWidth = (CONTENT_WIDTH - 16) / 2
  for (const [index, label] of ['Prepared by (automated)', 'Reviewed and approved by'].entries()) {
    const x = MARGIN + index * (boxWidth + 16)
    drawLine(ctx.doc, x, ctx.y + 18, x + boxWidth, ctx.y + 18, { color: RULE })
    drawText(ctx.doc, label, x, ctx.y + 28, { size: 7.5, color: MUTED })
    if (index === 0) {
      drawText(ctx.doc, 'Settlement Agent — automated procedure', x, ctx.y + 14, { size: 8.5, color: INK })
    }
  }
  ctx.y += 38
}

// --- layout primitives ---------------------------------------------------------------

function sectionTitle(ctx, title) {
  ensureSpace(ctx, 40)
  drawText(ctx.doc, title, MARGIN, ctx.y + 9, { font: FONTS.BOLD, size: 10, color: INK })
  ctx.y += 13
  drawLine(ctx.doc, MARGIN, ctx.y, MARGIN + CONTENT_WIDTH, ctx.y, { width: 0.6, color: RULE })
  ctx.y += 8
}

function emptyNote(ctx, text) {
  ensureSpace(ctx, 20)
  drawText(ctx.doc, text, MARGIN, ctx.y + 8, { size: 8.5, color: MUTED })
  ctx.y += 20
}

function drawKeyValues(ctx, pairs) {
  const labelWidth = 160
  for (const [label, value] of pairs) {
    ensureSpace(ctx, 14)
    drawText(ctx.doc, label, MARGIN, ctx.y + 8, { size: 8.5, color: MUTED, maxWidth: labelWidth })
    drawText(ctx.doc, value, MARGIN + labelWidth, ctx.y + 8, {
      size: 8.5,
      color: INK,
      maxWidth: CONTENT_WIDTH - labelWidth,
    })
    ctx.y += 13
  }
}

/**
 * A table with a shaded header, zebra striping and automatic page breaks.
 *
 * The header is redrawn at the top of every page it continues onto — a run of settlement
 * amounts with no column headings above them is exactly the kind of thing that gets
 * misread. Cells are truncated to their column width rather than overflowing into the
 * next one.
 */
function drawTable(ctx, { columns, rows, total = null }) {
  const headerHeight = 15
  const rowHeight = 13

  const drawHeader = () => {
    drawRect(ctx.doc, MARGIN, ctx.y, CONTENT_WIDTH, headerHeight, { color: HEADER_FILL })
    let x = MARGIN + 4
    for (const column of columns) {
      const isRight = column.align === 'right'
      drawText(ctx.doc, column.label, isRight ? x + column.width - 8 : x, ctx.y + 10.5, {
        font: FONTS.BOLD,
        size: 7.5,
        color: INK,
        align: isRight ? 'right' : 'left',
        maxWidth: column.width - 6,
      })
      x += column.width
    }
    ctx.y += headerHeight
  }

  ensureSpace(ctx, headerHeight + rowHeight * 2)
  drawHeader()

  rows.forEach((row, index) => {
    if (!hasSpace(ctx, rowHeight)) {
      newPage(ctx)
      drawHeader()
    }
    if (index % 2 === 1) {
      drawRect(ctx.doc, MARGIN, ctx.y, CONTENT_WIDTH, rowHeight, { color: [0.972, 0.975, 0.98] })
    }

    let x = MARGIN + 4
    for (const column of columns) {
      const isRight = column.align === 'right'
      drawText(ctx.doc, String(row[column.key] ?? ''), isRight ? x + column.width - 8 : x, ctx.y + 9, {
        size: 7.5,
        color: row._color?.[column.key] ?? INK,
        align: isRight ? 'right' : 'left',
        maxWidth: column.width - 6,
      })
      x += column.width
    }
    ctx.y += rowHeight
  })

  if (total) {
    if (!hasSpace(ctx, rowHeight + 4)) newPage(ctx)
    drawLine(ctx.doc, MARGIN, ctx.y, MARGIN + CONTENT_WIDTH, ctx.y, { width: 0.6, color: INK })
    let x = MARGIN + 4
    for (const column of columns) {
      const isRight = column.align === 'right'
      const value = total[column.key]
      if (value != null) {
        drawText(ctx.doc, String(value), isRight ? x + column.width - 8 : x, ctx.y + 10, {
          font: FONTS.BOLD,
          size: 7.5,
          color: total._color?.[column.key] ?? INK,
          align: isRight ? 'right' : 'left',
          maxWidth: column.width - 6,
        })
      }
      x += column.width
    }
    ctx.y += rowHeight + 2
  }

  ctx.y += 10
}

function hasSpace(ctx, needed) {
  return ctx.y + needed <= BOTTOM_LIMIT
}

function ensureSpace(ctx, needed) {
  if (!hasSpace(ctx, needed)) newPage(ctx)
}

function newPage(ctx) {
  addPage(ctx.doc)
  ctx.y = MARGIN
}

/**
 * Page numbers and provenance, stamped after the fact because "page 2 of 7" cannot be
 * written until the seventh page exists.
 */
function drawFooters(doc, result) {
  const total = pageCount(doc)
  const y = PAGE_SIZES.LETTER.height - 34

  for (let index = 0; index < total; index++) {
    onPage(doc, index, () => {
      drawLine(doc, MARGIN, y - 10, MARGIN + CONTENT_WIDTH, y - 10, { width: 0.5, color: RULE })
      drawText(
        doc,
        `${result.runId} · system-generated by the Settlement Agent · not a client confirmation`,
        MARGIN,
        y,
        { size: 7, color: MUTED, maxWidth: CONTENT_WIDTH - 80 },
      )
      drawText(doc, `Page ${index + 1} of ${total}`, MARGIN + CONTENT_WIDTH, y, {
        size: 7,
        color: MUTED,
        align: 'right',
      })
    })
  }
}

function statusColour(status) {
  if (status === 'SETTLED') return GOOD
  if (status === 'PENDING') return MUTED
  return BAD
}

function severityColour(severity) {
  if (severity === 'high') return BAD
  if (severity === 'medium') return WARN
  return MUTED
}

/** Exported for the tests that assert column widths stay inside the page. */
export const LAYOUT = { MARGIN, CONTENT_WIDTH, BOTTOM_LIMIT, measureText }
