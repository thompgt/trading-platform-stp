import { describe, it, expect, vi } from 'vitest'
import { detectPatterns, draftComplianceTriage } from '../src/agents/complianceAgent.js'
import { LlmValidationError } from '../src/agents/llmJson.js'

function fakeClient(responses) {
  let call = 0
  return {
    chat: {
      completions: {
        create: vi.fn(async () => {
          const content = responses[Math.min(call, responses.length - 1)]
          call++
          return { choices: [{ message: { content } }] }
        }),
      },
    },
  }
}

describe('detectPatterns', () => {
  it('returns no patterns for a small, non-alternating trade list', () => {
    const trades = [
      { side: 'BUY', qty: 10, price: 100 },
      { side: 'SELL', qty: 10, price: 105 },
    ]
    expect(detectPatterns(trades)).toEqual([])
  })

  it('flags a rapid reversal pattern when trades alternate side almost every time', () => {
    const trades = [
      { side: 'BUY', qty: 10, price: 100 },
      { side: 'SELL', qty: 10, price: 101 },
      { side: 'BUY', qty: 10, price: 100 },
      { side: 'SELL', qty: 10, price: 101 },
      { side: 'BUY', qty: 10, price: 100 },
    ]
    const patterns = detectPatterns(trades)
    expect(patterns.some((p) => p.id === 'rapid-reversal')).toBe(true)
  })

  it('flags an outsized trade relative to the session average', () => {
    const trades = [
      { side: 'BUY', qty: 10, price: 100 },
      { side: 'SELL', qty: 10, price: 100 },
      { side: 'BUY', qty: 200, price: 100 },
    ]
    const patterns = detectPatterns(trades)
    expect(patterns.some((p) => p.id === 'outsized-trade')).toBe(true)
  })
})

describe('draftComplianceTriage', () => {
  it('makes no LLM call and returns [] when no patterns are detected', async () => {
    const client = fakeClient([])
    const drafts = await draftComplianceTriage({ symbol: 'TEST', trades: [] }, { client })
    expect(drafts).toEqual([])
    expect(client.chat.completions.create).not.toHaveBeenCalled()
  })

  it('drafts a triage narrative for a detected pattern via the (mocked) LLM', async () => {
    const client = fakeClient([
      JSON.stringify({
        explanation: 'Trades alternate side almost every fill, consistent with rapid churn.',
        recommendation: 'Review order timestamps against the inside quote for this session.',
      }),
    ])
    const trades = [
      { side: 'BUY', qty: 10, price: 100 },
      { side: 'SELL', qty: 10, price: 101 },
      { side: 'BUY', qty: 10, price: 100 },
      { side: 'SELL', qty: 10, price: 101 },
      { side: 'BUY', qty: 10, price: 100 },
    ]
    const drafts = await draftComplianceTriage({ symbol: 'TEST', trades }, { client })
    expect(drafts).toHaveLength(1)
    expect(drafts[0].status).toBe('Pending compliance review')
    expect(drafts[0].aiDraft).toContain('not a filing')
  })

  it('propagates LlmValidationError when the model never returns valid JSON', async () => {
    const client = fakeClient(['nope', 'still not json', 'nope again'])
    const trades = [
      { side: 'BUY', qty: 10, price: 100 },
      { side: 'SELL', qty: 10, price: 101 },
      { side: 'BUY', qty: 10, price: 100 },
      { side: 'SELL', qty: 10, price: 101 },
      { side: 'BUY', qty: 10, price: 100 },
    ]
    await expect(draftComplianceTriage({ symbol: 'TEST', trades }, { client })).rejects.toBeInstanceOf(
      LlmValidationError,
    )
  })
})
