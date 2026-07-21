import { describe, it, expect, vi } from 'vitest'
import { answerCopilotQuery } from '../src/agents/copilotAgent.js'
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

describe('answerCopilotQuery', () => {
  it('rejects a blank question without calling the model', async () => {
    const client = fakeClient([])
    await expect(answerCopilotQuery({ question: '   ', facts: {} }, { client })).rejects.toThrow(
      /question is required/,
    )
    expect(client.chat.completions.create).not.toHaveBeenCalled()
  })

  it('returns a schema-valid grounded answer', async () => {
    const client = fakeClient([
      JSON.stringify({
        answer: 'Your largest unrealized gain is AAPL at +$7,170.',
        usedFacts: ['AAPL unrealized +7170'],
      }),
    ])
    const { answer, usedFacts } = await answerCopilotQuery(
      { question: "What's my biggest winner?", facts: { positions: [{ symbol: 'AAPL', unrealized: 7170 }] } },
      { client },
    )
    expect(answer).toContain('AAPL')
    expect(Array.isArray(usedFacts)).toBe(true)
  })

  it('surfaces LlmValidationError instead of silently returning malformed output', async () => {
    const client = fakeClient(['not json'])
    await expect(
      answerCopilotQuery({ question: 'anything?', facts: {} }, { client, maxAttempts: 1 }),
    ).rejects.toBeInstanceOf(LlmValidationError)
  })
})
