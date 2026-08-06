/**
 * Back office — the cash and securities ledger.
 *
 * Double-entry, in integer cents, with the balance check enforced at post time rather than
 * discovered at month end. Every posting is rejected unless its debits equal its credits,
 * so the books cannot be put out of balance by a bug upstream — the worst an upstream bug
 * can do is fail to post.
 *
 * The model is **trade-date accounting with a settlement-date cash movement**, which is the
 * distinction the whole post-trade stack exists to express:
 *
 *  - On *trade date* the economics are recognised. A purchase creates a security position
 *    and a payable; a sale relieves cost, recognises realised P&L and creates a receivable.
 *    No cash moves — we owe it, or are owed it.
 *  - On *settlement date* the cash actually moves, clearing the payable or receivable
 *    against the custodian cash account.
 *
 * That is why a settled trade produces two journal entries and an unsettled one produces
 * a single entry plus an open receivable/payable balance you can point at. "Where is the
 * money" becomes a question the ledger answers rather than a spreadsheet.
 */
import { formatCents } from './money.js'

export const ASSET = 'ASSET'
export const LIABILITY = 'LIABILITY'
export const EQUITY = 'EQUITY'
export const INCOME = 'INCOME'
export const EXPENSE = 'EXPENSE'

/** Debit-normal account types: a debit increases them, a credit decreases them. */
const DEBIT_NORMAL = new Set([ASSET, EXPENSE])

/**
 * Chart of accounts. Small on purpose — these are the accounts a single-currency equity
 * book actually touches, and an account nobody posts to is an account nobody reconciles.
 */
export const CHART_OF_ACCOUNTS = [
  { code: '1000', name: 'Cash at custodian', type: ASSET },
  { code: '1100', name: 'Cash receivable from broker', type: ASSET },
  { code: '1200', name: 'Securities at cost', type: ASSET },
  { code: '2000', name: 'Cash payable to broker', type: LIABILITY },
  { code: '3000', name: 'Opening equity', type: EQUITY },
  { code: '4000', name: 'Realised trading P&L', type: INCOME },
  { code: '5000', name: 'Commission expense', type: EXPENSE },
  { code: '5100', name: 'Regulatory fee expense', type: EXPENSE },
]

/** Stable handles, so a posting names an account rather than repeating a code string. */
export const ACCOUNTS = {
  CASH: '1000',
  CASH_RECEIVABLE: '1100',
  SECURITIES: '1200',
  CASH_PAYABLE: '2000',
  OPENING_EQUITY: '3000',
  REALISED_PNL: '4000',
  COMMISSION_EXPENSE: '5000',
  REGULATORY_FEE_EXPENSE: '5100',
}

const ACCOUNT_BY_CODE = new Map(CHART_OF_ACCOUNTS.map((account) => [account.code, account]))

/** Look up an account, failing loudly rather than posting into a code that does not exist. */
export function accountMeta(code) {
  const account = ACCOUNT_BY_CODE.get(code)
  if (!account) {
    throw new Error(`Unknown ledger account: ${code}`)
  }
  return account
}

/**
 * Open a set of books.
 *
 * Opening cash is posted as a real journal entry against opening equity rather than being
 * assigned as a starting number, so the trial balance holds from the very first line.
 */
export function createLedger({ openingCashCents = 0, openingDate = null } = {}) {
  const ledger = { entries: [], sequence: 0 }
  if (openingCashCents !== 0) {
    postEntry(ledger, {
      date: openingDate,
      narrative: 'Opening cash balance',
      reference: 'OPENING',
      lines: [
        { account: ACCOUNTS.CASH, side: 'DR', amountCents: openingCashCents },
        { account: ACCOUNTS.OPENING_EQUITY, side: 'CR', amountCents: openingCashCents },
      ],
    })
  }
  return ledger
}

/**
 * Post a journal entry.
 *
 * Rejects anything that would corrupt the books: an unbalanced entry, an unknown account,
 * a negative or non-integer amount, or an entry with fewer than two lines. Zero-amount
 * lines are dropped first — a fee schedule that produces no regulatory fee on a buy should
 * not litter the ledger with empty postings.
 */
export function postEntry(ledger, { date, narrative, reference = null, tradeId = null, lines }) {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new Error('Journal entry requires lines')
  }

  const posted = lines.filter((line) => line.amountCents !== 0)
  for (const line of posted) {
    accountMeta(line.account)
    if (line.side !== 'DR' && line.side !== 'CR') {
      throw new Error(`Journal line side must be DR or CR, got: ${line.side}`)
    }
    if (!Number.isInteger(line.amountCents) || line.amountCents < 0) {
      throw new Error(
        `Journal line amount must be a non-negative integer cent amount, got: ${line.amountCents}`,
      )
    }
  }

  if (posted.length < 2) {
    throw new Error('Journal entry requires at least two non-zero lines')
  }

  const debits = sumSide(posted, 'DR')
  const credits = sumSide(posted, 'CR')
  if (debits !== credits) {
    throw new Error(
      `Journal entry does not balance: debits ${formatCents(debits)} vs credits ${formatCents(credits)}`,
    )
  }

  ledger.sequence += 1
  const entry = {
    entryId: `JRN-${String(ledger.sequence).padStart(4, '0')}`,
    date,
    narrative,
    reference,
    tradeId,
    lines: posted.map((line) => ({ ...line })),
    totalCents: debits,
  }
  ledger.entries.push(entry)
  return entry
}

/**
 * Balances for every account that has been posted to, in chart order.
 *
 * `balanceCents` is signed by the account's normal balance — a positive cash balance and a
 * positive payable both mean "there is more of this", which is how a human reads a trial
 * balance. `debitsCents`/`creditsCents` are kept alongside so the raw movement is visible.
 */
export function balances(ledger) {
  const totals = new Map()

  for (const entry of ledger.entries) {
    for (const line of entry.lines) {
      const current = totals.get(line.account) ?? { debitsCents: 0, creditsCents: 0 }
      if (line.side === 'DR') current.debitsCents += line.amountCents
      else current.creditsCents += line.amountCents
      totals.set(line.account, current)
    }
  }

  return CHART_OF_ACCOUNTS.filter((account) => totals.has(account.code)).map((account) => {
    const { debitsCents, creditsCents } = totals.get(account.code)
    const natural = DEBIT_NORMAL.has(account.type)
      ? debitsCents - creditsCents
      : creditsCents - debitsCents
    return {
      code: account.code,
      name: account.name,
      type: account.type,
      debitsCents,
      creditsCents,
      balanceCents: natural,
    }
  })
}

/** Balance of a single account in cents, normal-balance signed. Zero if never posted to. */
export function balanceOf(ledger, code) {
  accountMeta(code)
  return balances(ledger).find((row) => row.code === code)?.balanceCents ?? 0
}

/**
 * Trial balance. `inBalance` is the assertion the whole module exists to make true; it is
 * recomputed from the posted lines rather than trusted from the post-time check, so it
 * would catch an entry mutated after the fact.
 */
export function trialBalance(ledger) {
  const rows = balances(ledger)
  const totalDebitsCents = rows.reduce((sum, row) => sum + row.debitsCents, 0)
  const totalCreditsCents = rows.reduce((sum, row) => sum + row.creditsCents, 0)
  return {
    rows,
    totalDebitsCents,
    totalCreditsCents,
    inBalance: totalDebitsCents === totalCreditsCents,
  }
}

/**
 * A running statement for one account — date, entry, narrative, debit, credit, balance.
 * Applied to the cash account this is the cash ledger the ops team actually reads.
 */
export function accountStatement(ledger, code) {
  const meta = accountMeta(code)
  const debitNormal = DEBIT_NORMAL.has(meta.type)
  let running = 0

  const lines = []
  for (const entry of ledger.entries) {
    for (const line of entry.lines) {
      if (line.account !== code) continue
      const signed = line.side === 'DR' ? line.amountCents : -line.amountCents
      running += debitNormal ? signed : -signed
      lines.push({
        entryId: entry.entryId,
        date: entry.date,
        narrative: entry.narrative,
        reference: entry.reference,
        tradeId: entry.tradeId,
        debitCents: line.side === 'DR' ? line.amountCents : 0,
        creditCents: line.side === 'CR' ? line.amountCents : 0,
        balanceCents: running,
      })
    }
  }

  return {
    account: { ...meta },
    lines,
    closingBalanceCents: running,
  }
}

/** The cash account statement — the movement of actual money, settlement date by settlement date. */
export function cashLedger(ledger) {
  return accountStatement(ledger, ACCOUNTS.CASH)
}

function sumSide(lines, side) {
  return lines.reduce((sum, line) => (line.side === side ? sum + line.amountCents : sum), 0)
}
