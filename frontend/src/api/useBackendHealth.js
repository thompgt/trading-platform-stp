import { useEffect, useState } from 'react'
import { get } from './client.js'

/** Polls the backend health endpoint so the UI can surface "backend is down" proactively. */
export function useBackendHealth(intervalMs = 15000) {
  const [status, setStatus] = useState('checking') // 'checking' | 'online' | 'offline'

  useEffect(() => {
    let cancelled = false

    async function check() {
      try {
        await get('/health')
        if (!cancelled) setStatus('online')
      } catch {
        if (!cancelled) setStatus('offline')
      }
    }

    check()
    const id = setInterval(check, intervalMs)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [intervalMs])

  return status
}
