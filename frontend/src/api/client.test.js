import { describe, it, expect, vi, afterEach } from 'vitest'
import { get, post, ApiError } from './client.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('API client', () => {
  it('returns parsed JSON on a successful response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ hello: 'world' }) }),
    )
    const data = await get('/whatever')
    expect(data).toEqual({ hello: 'world' })
  })

  it('throws an ApiError with the server-provided message on a non-2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: 'symbol is required' }) }),
    )
    await expect(post('/data/fetch', {})).rejects.toMatchObject({
      name: 'ApiError',
      status: 400,
      message: 'symbol is required',
    })
  })

  it('throws a helpful ApiError when the network request itself fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
    )
    await expect(get('/data/symbols')).rejects.toBeInstanceOf(ApiError)
    await expect(get('/data/symbols')).rejects.toThrow(/Could not reach the backend/)
  })

  it('does not throw when the server returns a non-JSON error body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => {
          throw new SyntaxError('Unexpected end of JSON input')
        },
      }),
    )
    await expect(get('/whatever')).rejects.toMatchObject({ status: 500 })
  })
})
