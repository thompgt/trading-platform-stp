import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Sidebar from './Sidebar.jsx'
import { useBackendHealth } from '../api/useBackendHealth.js'

vi.mock('../api/useBackendHealth.js')

function renderSidebar() {
  return render(
    <MemoryRouter>
      <Sidebar />
    </MemoryRouter>,
  )
}

describe('Sidebar', () => {
  it('renders navigation links for every major feature area', () => {
    useBackendHealth.mockReturnValue('checking')
    renderSidebar()
    expect(screen.getByRole('link', { name: /Dashboard/ })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Paper Trading/ })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Risk & Compliance/ })).toBeInTheDocument()
  })

  it('shows an online indicator when the backend health check succeeds', () => {
    useBackendHealth.mockReturnValue('online')
    renderSidebar()
    expect(screen.getByText('Backend online')).toBeInTheDocument()
  })

  it('shows an offline indicator instead of silently failing when the backend is down', () => {
    useBackendHealth.mockReturnValue('offline')
    renderSidebar()
    expect(screen.getByText('Backend offline')).toBeInTheDocument()
  })
})
