import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { callGroqForJson, LlmValidationError, LlmTimeoutError } from '../src/agents/llmJson.js'

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

describe('callGroqForJson timeouts', () => {
  /** A client that honours the abort signal, standing in for a hung upstream. */
  function hangingClient() {
    return {
      chat: {
        completions: {
          create: vi.fn(
            (_body, { signal } = {}) =>
              new Promise((_resolve, reject) => {
                signal?.addEventListener('abort', () => reject(signal.reason))
              }),
          ),
        },
      },
    }
  }

  it('aborts a hung request rather than holding the handler open', async () => {
    const client = hangingClient()
    await expect(
      callGroqForJson({
        systemPrompt: 'sys',
        userPrompt: 'usr',
        schema,
        client,
        requestTimeoutMs: 30,
        deadlineMs: 5000,
      }),
    ).rejects.toBeInstanceOf(LlmTimeoutError)

    // One attempt, aborted — not three sequential hangs.
    expect(client.chat.completions.create).toHaveBeenCalledTimes(1)
  })

  it('passes an abort signal on every attempt', async () => {
    const client = fakeClient([JSON.stringify({ name: 'Ada', age: 30 })])
    await callGroqForJson({ systemPrompt: 'sys', userPrompt: 'usr', schema, client })
    const [, requestOptions] = client.chat.completions.create.mock.calls[0]
    expect(requestOptions.signal).toBeInstanceOf(AbortSignal)
  })

  it('stops at the overall deadline even when each attempt is individually quick', async () => {
    // Every response is invalid, so the loop would otherwise run all three attempts; each
    // one burns more than the deadline allows.
    let calls = 0
    const client = {
      chat: {
        completions: {
          create: vi.fn(async () => {
            calls++
            await new Promise((r) => setTimeout(r, 40))
            return { choices: [{ message: { content: 'not json' } }] }
          }),
        },
      },
    }

    await expect(
      callGroqForJson({
        systemPrompt: 'sys',
        userPrompt: 'usr',
        schema,
        client,
        requestTimeoutMs: 5000,
        deadlineMs: 60,
      }),
    ).rejects.toBeInstanceOf(LlmTimeoutError)
    expect(calls).toBeLessThan(3)
  })

  it('leaves a genuine transport error as itself, not a timeout', async () => {
    const client = {
      chat: {
        completions: { create: vi.fn(async () => { throw new Error('socket hang up') }) },
      },
    }
    await expect(
      callGroqForJson({ systemPrompt: 'sys', userPrompt: 'usr', schema, client }),
    ).rejects.toThrowError(/socket hang up/)
  })
})
