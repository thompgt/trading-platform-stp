import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { useBackendHealth } from './useBackendHealth.js'
import * as client from './client.js'

vi.mock('./client.js')

function Probe({ intervalMs }) {
  const status = useBackendHealth(intervalMs)
  return <div>status: {status}</div>
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useBackendHealth', () => {
  it('starts in "checking" and moves to "online" when the health check succeeds', async () => {
    client.get.mockResolvedValue({ ok: true })
    render(<Probe intervalMs={100000} />)
    expect(screen.getByText('status: checking')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('status: online')).toBeInTheDocument())
  })

  it('reports "offline" instead of throwing when the health check fails', async () => {
    client.get.mockRejectedValue(new Error('network error'))
    render(<Probe intervalMs={100000} />)
    await waitFor(() => expect(screen.getByText('status: offline')).toBeInTheDocument())
  })
})
