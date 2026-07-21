import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { callGroqForJson, LlmValidationError } from '../src/agents/llmJson.js'

const schema = z.object({ name: z.string(), age: z.number().int().min(0) })

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

describe('callGroqForJson', () => {
  it('returns validated data when the model answers correctly on the first try', async () => {
    const client = fakeClient([JSON.stringify({ name: 'Ada', age: 30 })])
    const { data, attempts } = await callGroqForJson({
      systemPrompt: 'sys',
      userPrompt: 'usr',
      schema,
      client,
    })
    expect(data).toEqual({ name: 'Ada', age: 30 })
    expect(attempts).toBe(1)
    expect(client.chat.completions.create).toHaveBeenCalledTimes(1)
  })

  it('retries and recovers when the first response is not valid JSON', async () => {
    const client = fakeClient(['not json at all', JSON.stringify({ name: 'Grace', age: 45 })])
    const { data, attempts } = await callGroqForJson({
      systemPrompt: 'sys',
      userPrompt: 'usr',
      schema,
      client,
    })
    expect(data.name).toBe('Grace')
    expect(attempts).toBe(2)
  })

  it('retries and recovers when the JSON is valid but fails schema validation', async () => {
    const client = fakeClient([
      JSON.stringify({ name: 'Ada', age: -5 }), // fails min(0)
      JSON.stringify({ name: 'Ada', age: 30 }),
    ])
    const { data, attempts } = await callGroqForJson({
      systemPrompt: 'sys',
      userPrompt: 'usr',
      schema,
      client,
    })
    expect(data.age).toBe(30)
    expect(attempts).toBe(2)
  })

  it('throws LlmValidationError instead of returning bad data after exhausting retries', async () => {
    const client = fakeClient(['still not json', 'still not json', 'still not json'])
    await expect(
      callGroqForJson({ systemPrompt: 'sys', userPrompt: 'usr', schema, client, maxAttempts: 3 }),
    ).rejects.toBeInstanceOf(LlmValidationError)
    expect(client.chat.completions.create).toHaveBeenCalledTimes(3)
  })

  it('never resolves with data that failed schema validation', async () => {
    const client = fakeClient([JSON.stringify({ name: 'X', age: 'not-a-number' })])
    await expect(
      callGroqForJson({ systemPrompt: 'sys', userPrompt: 'usr', schema, client, maxAttempts: 1 }),
    ).rejects.toThrow(/valid JSON/)
  })

  it('rejects extra/malformed content wrapped around JSON (markdown fences) as invalid JSON', async () => {
    const client = fakeClient(['```json\n{"name":"Ada","age":30}\n```'])
    await expect(
      callGroqForJson({ systemPrompt: 'sys', userPrompt: 'usr', schema, client, maxAttempts: 1 }),
    ).rejects.toBeInstanceOf(LlmValidationError)
  })
})
