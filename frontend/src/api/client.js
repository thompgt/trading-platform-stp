const BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000/api'

export class ApiError extends Error {
  constructor(message, status) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function request(path, { method = 'GET', body } = {}) {
  let res
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    })
  } catch {
    throw new ApiError(
      `Could not reach the backend at ${BASE_URL}. Is it running? (cd backend && npm run dev)`,
      0,
    )
  }

  let payload = null
  try {
    payload = await res.json()
  } catch {
    // Non-JSON response body — fall through with payload = null.
  }

  if (!res.ok) {
    throw new ApiError(payload?.error || `Request failed with status ${res.status}`, res.status)
  }

  return payload
}

export const get = (path) => request(path)
export const post = (path, body) => request(path, { method: 'POST', body: body ?? {} })
export const put = (path, body) => request(path, { method: 'PUT', body: body ?? {} })
