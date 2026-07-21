import { describe, it, expect, vi } from 'vitest'
import { generateStrategy } from '../src/agents/strategyAgent.js'
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

describe('generateStrategy', () => {
  it('returns a schema-valid, runner-compatible sma_crossover strategy', async () => {
    const client = fakeClient([
      JSON.stringify({
        name: 'Golden Cross Momentum',
        rationale: 'Captures medium-term trend shifts using a fast/slow moving average cross.',
        kind: 'sma_crossover',
        params: { fastPeriod: 10, slowPeriod: 50 },
      }),
    ])
    const { strategy, attempts } = await generateStrategy({ symbol: 'AAPL' }, { client })
    expect(strategy.kind).toBe('sma_crossover')
    expect(strategy.params.fastPeriod).toBeLessThan(strategy.params.slowPeriod)
    expect(attempts).toBe(1)
  })

  it('rejects a strategy kind outside the two supported by the deterministic runner', async () => {
    const client = fakeClient([
      JSON.stringify({
        name: 'Custom Script',
        rationale: 'Runs arbitrary logic',
        kind: 'run_python_script',
        params: {},
      }),
    ])
    await expect(generateStrategy({ symbol: 'AAPL' }, { client, maxAttempts: 1 })).rejects.toBeInstanceOf(
      LlmValidationError,
    )
  })

  it('rejects a schema-valid but logically inverted sma_crossover (fast >= slow)', async () => {
    const client = fakeClient([
      JSON.stringify({
        name: 'Broken',
        rationale: 'fast period is not actually faster than slow period',
        kind: 'sma_crossover',
        params: { fastPeriod: 50, slowPeriod: 10 },
      }),
    ])
    await expect(generateStrategy({ symbol: 'AAPL' }, { client })).rejects.toThrow(/fastPeriod must be less than/)
  })

  it('rejects a logically inverted rsi_threshold (oversold >= overbought)', async () => {
    const client = fakeClient([
      JSON.stringify({
        name: 'Broken RSI',
        rationale: 'thresholds are backwards',
        kind: 'rsi_threshold',
        params: { period: 14, oversold: 50, overbought: 50 },
      }),
    ])
    await expect(generateStrategy({ symbol: 'AAPL' }, { client })).rejects.toThrow(/oversold must be less than/)
  })
})
