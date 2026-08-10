const BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000/api'

// The backend requires a shared key on every /api route. This is a local-sandbox arrangement:
// a key shipped in a browser bundle is readable by anyone who loads the page, so it keeps the
// API closed to the open internet, not to the SPA's own user. A real deployment would put a
// per-user session in front of this instead.
const API_KEY = import.meta.env.VITE_API_KEY || ''

function authHeaders(hasBody) {
  const headers = {}
  if (hasBody) headers['Content-Type'] = 'application/json'
  if (API_KEY) headers['X-API-Key'] = API_KEY
  return Object.keys(headers).length > 0 ? headers : undefined
}

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
      headers: authHeaders(Boolean(body)),
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
