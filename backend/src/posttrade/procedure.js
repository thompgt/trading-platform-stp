/**
 * The automated settlement procedure — the whole back and middle office, end to end.
 *
 * This is the thing the individual modules exist to be composed into: hand it the fills a
 * trading session produced and it runs trade capture, enrichment, confirmation matching,
 * settlement instruction and DVP settlement, fails management, double-entry cash
 * accounting, and custodian reconciliation, in order, with no human in the loop.
 *
 * Design decisions worth stating, because they are what make it an *automated procedure*
 * rather than a script that happens to produce numbers:
 *
 *  - **One pass, no retries hidden inside.** Each stage consumes the previous stage's
 *    output and produces its own. There is no loop that quietly re-runs a stage until it
 *    likes the answer, which means the stage report is a truthful account of what happened.
 *  - **Exceptions accumulate, they do not abort.** A fill that will not enrich, a trade
 *    that will not affirm, a sale with no position behind it — each one drops out to the
 *    exception queue with a reason, and everything else keeps flowing. A batch of a hundred
 *    trades is not held up by one bad ticket, which is precisely the manual bottleneck STP
 *    is meant to remove.
 *  - **Nothing is random and nothing reads the clock** except the report timestamp, which
 *    the caller can supply. Run the same fills twice and you get the same trade IDs, the
 *    same journal entries and the same PDF. A settlement report that cannot be reproduced
 *    is not evidence of anything.
 *  - **The straight-through rate is measured, not asserted.** `stpRatePct` is the share of
 *    captured fills that reached SETTLED without any human touchpoint. It is the one number
 *    that says whether the automation is actually working, so it is computed from outcomes
 *    rather than from intent.
 */
import { enrichTrades } from './enrichment.js'
import { buildCounterpartyAdvices } from './counterpartyFeed.js'
import { matchTrades } from './matching.js'
import { createLedger, trialBalance, balances, cashLedger, balanceOf, ACCOUNTS } from './ledger.js'
import { createBook, snapshot } from './positions.js'
import { settleTrades, DEFAULT_FAILS_POLICY } from './settlement.js'
import { buildCustodianStatement } from './custodianFeed.js'
import { reconcile } from './reconciliation.js'
import { sumCents, toCents } from './money.js'
import { isoDate } from './calendar.js'
import { FIRM, BASE_CURRENCY, DEFAULT_COUNTERPARTY_ID } from './staticData.js'

/**
 * Run the full post-trade procedure over a batch of fills.
 *
 * The `confirmDiscrepancies`, `failedTradeIds` and `custodianDiscrepancies` options are the
 * seams where the outside world's disagreement enters — a broker confirm that does not
 * match, an instruction the custodian did not clear, a statement that disagrees with our
 * books. In production they are inbound feeds; here they are explicit inputs, which is what
 * lets the exception paths be demonstrated and tested without waiting for a real break.
 */
export function runSettlementProcedure(options = {}) {
  const {
    symbol,
    fills = [],
    startingCash = 0,
    openingCashCents = toCents(startingCash),
    valuationDate = null,
    counterpartyId = DEFAULT_COUNTERPARTY_ID,
    currency = BASE_CURRENCY,
    account = FIRM.tradingAccount,
    confirmDiscrepancies = {},
    failedTradeIds = [],
    custodianDiscrepancies = {},
    failsPolicy = DEFAULT_FAILS_POLICY,
    runId = null,
    generatedAt = new Date().toISOString(),
  } = options

  if (!symbol) {
    throw new Error('runSettlementProcedure requires a symbol')
  }

  // The valuation date decides which trades are *due* and therefore what the
  // straight-through rate is measured against. `settleTrades` defaults it to the latest
  // settlement date in the batch, which is a reasonable convenience for a replay but a
  // dishonest default for a control report: it marks every trade due, so nothing can be
  // pending and the headline rate is measured against a date chosen to flatter it. Default
  // instead to the caller's own today, taken from the report timestamp rather than a fresh
  // clock read so the run stays reproducible — pass `generatedAt` and the whole report,
  // valuation date included, is a pure function of the inputs.
  const asOfDate = valuationDate ?? isoDate(generatedAt)

  const ticker = String(symbol).toUpperCase()
  const stages = []
  const exceptions = []

  // --- 1. Trade capture -------------------------------------------------------------
  // Nothing to compute; the stage exists so the report can state how many executions the
  // procedure was handed, against which every later count is read.
  stages.push({
    name: 'Trade capture',
    desk: 'Middle office',
    in: fills.length,
    out: fills.length,
    exceptions: 0,
    status: 'CLEAN',
  })

  // --- 2. Enrichment ----------------------------------------------------------------
  const enrichment = enrichTrades(fills, { symbol: ticker, counterpartyId, currency, account })
  exceptions.push(...enrichment.exceptions)
  stages.push({
    name: 'Enrichment',
    desk: 'Middle office',
    in: fills.length,
    out: enrichment.trades.length,
    exceptions: enrichment.exceptions.length,
    status: enrichment.exceptions.length === 0 ? 'CLEAN' : 'EXCEPTIONS',
  })

  // --- 3. Confirmation and affirmation ----------------------------------------------
  const advices = buildCounterpartyAdvices(enrichment.trades, {
    discrepancies: confirmDiscrepancies,
  })
  const matching = matchTrades(enrichment.trades, advices)
  exceptions.push(...matching.breaks)
  const affirmedCount = matching.trades.filter((t) => t.status === 'AFFIRMED').length
  stages.push({
    name: 'Confirmation matching',
    desk: 'Middle office',
    in: enrichment.trades.length,
    out: affirmedCount,
    exceptions: matching.breaks.length,
    status: matching.breaks.length === 0 ? 'CLEAN' : 'EXCEPTIONS',
  })

  // --- 4. Settlement ----------------------------------------------------------------
  const ledger = createLedger({ openingCashCents, openingDate: earliestTradeDate(matching.trades) })
  const book = createBook()
  const settlement = settleTrades(matching.trades, {
    ledger,
    book,
    valuationDate: asOfDate,
    failedTradeIds,
    failsPolicy,
  })
  exceptions.push(...settlement.exceptions)
  const settledCount = settlement.trades.filter((t) => t.settlementStatus === 'SETTLED').length
  stages.push({
    name: 'Settlement (DVP)',
    desk: 'Back office',
    in: affirmedCount,
    out: settledCount,
    exceptions: settlement.exceptions.length + settlement.fails.length,
    status: settlement.exceptions.length + settlement.fails.length === 0 ? 'CLEAN' : 'EXCEPTIONS',
  })

  // --- 5. Reconciliation ------------------------------------------------------------
  const asOf = settlement.valuationDate
  const statement = buildCustodianStatement({
    ledger,
    book,
    valuationDate: asOf,
    counterpartyId,
    discrepancies: custodianDiscrepancies,
  })
  const recon = reconcile({ ledger, book, statement })
  exceptions.push(...recon.breaks)
  stages.push({
    name: 'Custodian reconciliation',
    desk: 'Back office',
    in: recon.linesChecked,
    out: recon.linesChecked - recon.breaks.length,
    exceptions: recon.breaks.length,
    status: recon.reconciled ? 'CLEAN' : 'EXCEPTIONS',
  })

  const tb = trialBalance(ledger)
  const summary = buildSummary({
    asOf,
    fills,
    trades: settlement.trades,
    fails: settlement.fails,
    exceptions,
    ledger,
    tb,
    recon,
  })

  return {
    runId: runId ?? `STL-${ticker}-${(asOf ?? 'NA').replace(/-/g, '')}`,
    generatedAt,
    symbol: ticker,
    valuationDate: asOf,
    entity: { ...FIRM },
    parameters: {
      currency,
      account,
      counterpartyId,
      openingCashCents,
      failsPolicy: { ...failsPolicy },
    },
    stages,
    trades: settlement.trades,
    instructions: settlement.instructions,
    fails: settlement.fails,
    exceptions,
    ledger: {
      entries: ledger.entries,
      balances: balances(ledger),
      trialBalance: tb,
      cash: cashLedger(ledger),
    },
    positions: snapshot(book),
    custodianStatement: statement,
    reconciliation: recon,
    summary,
  }
}

function buildSummary({ asOf, fills, trades, fails, exceptions, ledger, tb, recon }) {
  const byStatus = (status) => trades.filter((t) => t.settlementStatus === status).length
  const settled = trades.filter((t) => t.settlementStatus === 'SETTLED')

  const capturedCount = fills.length
  const settledCount = settled.length

  return {
    capturedCount,
    enrichedCount: trades.length,
    affirmedCount: trades.filter((t) => t.status === 'AFFIRMED').length,
    settledCount,
    pendingCount: byStatus('PENDING'),
    failedCount: byStatus('FAILED'),
    blockedCount: byStatus('BLOCKED'),
    // The headline control metric: the share of captured executions that reached settled
    // with no human touchpoint anywhere in the chain. It is only meaningful next to the
    // date it was measured on — a trade that has not reached its settlement date yet is
    // pending, not a straight-through failure — so the as-of date travels with it.
    stpRatePct: capturedCount === 0 ? 0 : (settledCount / capturedCount) * 100,
    stpRateAsOf: asOf ?? null,
    grossCents: sumCents(settled.map((t) => t.grossCents)),
    feesCents: sumCents(settled.map((t) => t.totalFeesCents)),
    // Net movement of actual cash: what came in on sales less what went out on purchases.
    netCashMovementCents: sumCents(
      settled.map((t) => (t.side === 'SELL' ? t.netAmountCents : -t.netAmountCents)),
    ),
    realisedPnlCents: balanceOf(ledger, ACCOUNTS.REALISED_PNL),
    closingCashCents: balanceOf(ledger, ACCOUNTS.CASH),
    openReceivableCents: balanceOf(ledger, ACCOUNTS.CASH_RECEIVABLE),
    openPayableCents: balanceOf(ledger, ACCOUNTS.CASH_PAYABLE),
    journalEntryCount: ledger.entries.length,
    inBalance: tb.inBalance,
    reconciled: recon.reconciled,
    failsCount: fails.length,
    exceptionCount: exceptions.length,
  }
}

function earliestTradeDate(trades) {
  let earliest = null
  for (const trade of trades) {
    if (trade.tradeDate && (earliest == null || trade.tradeDate < earliest)) {
      earliest = trade.tradeDate
    }
  }
  return earliest
}
