import { describe, it, expect } from 'vitest'
import {
  createLedger,
  postEntry,
  balances,
  balanceOf,
  trialBalance,
  accountStatement,
  cashLedger,
  accountMeta,
  ACCOUNTS,
} from '../src/posttrade/ledger.js'

function buyEntry(ledger, { date = '2025-03-05', grossCents = 2512500, commissionCents = 250 } = {}) {
  return postEntry(ledger, {
    date,
    narrative: 'Purchase 500 AAPL',
    tradeId: 'TRD-AAPL-0001',
    lines: [
      { account: ACCOUNTS.SECURITIES, side: 'DR', amountCents: grossCents },
      { account: ACCOUNTS.COMMISSION_EXPENSE, side: 'DR', amountCents: commissionCents },
      { account: ACCOUNTS.CASH_PAYABLE, side: 'CR', amountCents: grossCents + commissionCents },
    ],
  })
}

describe('createLedger', () => {
  it('posts opening cash as a real balanced entry', () => {
    const ledger = createLedger({ openingCashCents: 10_000_000, openingDate: '2025-03-01' })
    expect(ledger.entries).toHaveLength(1)
    expect(ledger.entries[0].entryId).toBe('JRN-0001')
    expect(balanceOf(ledger, ACCOUNTS.CASH)).toBe(10_000_000)
    expect(balanceOf(ledger, ACCOUNTS.OPENING_EQUITY)).toBe(10_000_000)
    expect(trialBalance(ledger).inBalance).toBe(true)
  })

  it('opens empty books when there is no opening cash', () => {
    const ledger = createLedger()
    expect(ledger.entries).toEqual([])
    expect(trialBalance(ledger).inBalance).toBe(true)
  })
})

describe('postEntry', () => {
  it('numbers entries sequentially and records the total', () => {
    const ledger = createLedger({ openingCashCents: 10_000_000 })
    const entry = buyEntry(ledger)
    expect(entry.entryId).toBe('JRN-0002')
    expect(entry.totalCents).toBe(2512750)
  })

  it('refuses an entry that does not balance', () => {
    const ledger = createLedger()
    expect(() =>
      postEntry(ledger, {
        date: '2025-03-05',
        narrative: 'Broken',
        lines: [
          { account: ACCOUNTS.CASH, side: 'DR', amountCents: 100 },
          { account: ACCOUNTS.OPENING_EQUITY, side: 'CR', amountCents: 90 },
        ],
      }),
    ).toThrow(/does not balance/)
    expect(ledger.entries).toEqual([])
  })

  it('refuses an unknown account', () => {
    const ledger = createLedger()
    expect(() =>
      postEntry(ledger, {
        date: '2025-03-05',
        narrative: 'Bad account',
        lines: [
          { account: '9999', side: 'DR', amountCents: 100 },
          { account: ACCOUNTS.CASH, side: 'CR', amountCents: 100 },
        ],
      }),
    ).toThrow(/Unknown ledger account/)
  })

  it('refuses negative, fractional and mis-sided amounts', () => {
    const ledger = createLedger()
    const line = (patch) => ({
      date: '2025-03-05',
      narrative: 'Bad line',
      lines: [{ account: ACCOUNTS.CASH, side: 'DR', amountCents: 100, ...patch }, { account: ACCOUNTS.OPENING_EQUITY, side: 'CR', amountCents: 100 }],
    })
    expect(() => postEntry(ledger, line({ amountCents: -100 }))).toThrow(/non-negative integer/)
    expect(() => postEntry(ledger, line({ amountCents: 10.5 }))).toThrow(/non-negative integer/)
    expect(() => postEntry(ledger, line({ side: 'XX' }))).toThrow(/must be DR or CR/)
  })

  it('drops zero-amount lines rather than littering the ledger', () => {
    const ledger = createLedger()
    const entry = postEntry(ledger, {
      date: '2025-03-05',
      narrative: 'Buy with no regulatory fee',
      lines: [
        { account: ACCOUNTS.SECURITIES, side: 'DR', amountCents: 1000 },
        { account: ACCOUNTS.REGULATORY_FEE_EXPENSE, side: 'DR', amountCents: 0 },
        { account: ACCOUNTS.CASH_PAYABLE, side: 'CR', amountCents: 1000 },
      ],
    })
    expect(entry.lines).toHaveLength(2)
  })

  it('rejects an entry that collapses to a single line', () => {
    const ledger = createLedger()
    expect(() =>
      postEntry(ledger, {
        date: '2025-03-05',
        narrative: 'Half an entry',
        lines: [
          { account: ACCOUNTS.CASH, side: 'DR', amountCents: 0 },
          { account: ACCOUNTS.OPENING_EQUITY, side: 'CR', amountCents: 0 },
        ],
      }),
    ).toThrow(/at least two non-zero lines/)
  })
})

describe('balances and trial balance', () => {
  it('signs balances by the account normal side', () => {
    const ledger = createLedger({ openingCashCents: 10_000_000 })
    buyEntry(ledger)

    const rows = balances(ledger)
    const payable = rows.find((r) => r.code === ACCOUNTS.CASH_PAYABLE)
    // A credit-normal liability with a credit balance reads positive.
    expect(payable.balanceCents).toBe(2512750)
    expect(payable.creditsCents).toBe(2512750)
    expect(payable.debitsCents).toBe(0)
  })

  it('omits accounts nobody has posted to', () => {
    const ledger = createLedger({ openingCashCents: 100 })
    expect(balances(ledger).map((r) => r.code)).toEqual([ACCOUNTS.CASH, ACCOUNTS.OPENING_EQUITY])
    expect(balanceOf(ledger, ACCOUNTS.REALISED_PNL)).toBe(0)
  })

  it('stays in balance across a full trade-date and settlement-date pair', () => {
    const ledger = createLedger({ openingCashCents: 10_000_000 })
    buyEntry(ledger)
    postEntry(ledger, {
      date: '2025-03-06',
      narrative: 'Settle purchase 500 AAPL',
      tradeId: 'TRD-AAPL-0001',
      lines: [
        { account: ACCOUNTS.CASH_PAYABLE, side: 'DR', amountCents: 2512750 },
        { account: ACCOUNTS.CASH, side: 'CR', amountCents: 2512750 },
      ],
    })

    const tb = trialBalance(ledger)
    expect(tb.inBalance).toBe(true)
    expect(tb.totalDebitsCents).toBe(tb.totalCreditsCents)
    expect(balanceOf(ledger, ACCOUNTS.CASH_PAYABLE)).toBe(0) // payable cleared by settlement
    expect(balanceOf(ledger, ACCOUNTS.CASH)).toBe(10_000_000 - 2512750)
  })

  it('leaves an open payable when a trade has not settled', () => {
    const ledger = createLedger({ openingCashCents: 10_000_000 })
    buyEntry(ledger)
    expect(balanceOf(ledger, ACCOUNTS.CASH_PAYABLE)).toBe(2512750)
    expect(balanceOf(ledger, ACCOUNTS.CASH)).toBe(10_000_000) // no cash moved on trade date
  })
})

describe('cash ledger', () => {
  it('runs a balance forward line by line', () => {
    const ledger = createLedger({ openingCashCents: 10_000_000, openingDate: '2025-03-01' })
    postEntry(ledger, {
      date: '2025-03-06',
      narrative: 'Settle purchase',
      tradeId: 'TRD-AAPL-0001',
      lines: [
        { account: ACCOUNTS.CASH_PAYABLE, side: 'DR', amountCents: 2512750 },
        { account: ACCOUNTS.CASH, side: 'CR', amountCents: 2512750 },
      ],
    })
    postEntry(ledger, {
      date: '2025-03-07',
      narrative: 'Settle sale',
      tradeId: 'TRD-AAPL-0002',
      lines: [
        { account: ACCOUNTS.CASH, side: 'DR', amountCents: 2624669 },
        { account: ACCOUNTS.CASH_RECEIVABLE, side: 'CR', amountCents: 2624669 },
      ],
    })

    const statement = cashLedger(ledger)
    expect(statement.account.code).toBe(ACCOUNTS.CASH)
    expect(statement.lines.map((l) => l.balanceCents)).toEqual([
      10_000_000,
      10_000_000 - 2512750,
      10_000_000 - 2512750 + 2624669,
    ])
    expect(statement.lines[1]).toMatchObject({
      debitCents: 0,
      creditCents: 2512750,
      tradeId: 'TRD-AAPL-0001',
    })
    expect(statement.closingBalanceCents).toBe(balanceOf(ledger, ACCOUNTS.CASH))
  })

  it('reads a credit-normal account in its own direction', () => {
    const ledger = createLedger({ openingCashCents: 10_000_000 })
    buyEntry(ledger)
    const statement = accountStatement(ledger, ACCOUNTS.CASH_PAYABLE)
    expect(statement.closingBalanceCents).toBe(2512750)
  })

  it('rejects a statement for an account outside the chart', () => {
    expect(() => accountMeta('9999')).toThrow(/Unknown ledger account/)
  })
})
