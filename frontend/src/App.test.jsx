import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import App from './App.jsx'

function renderAt(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  )
}

describe('App routing', () => {
  it('renders the dashboard at /', () => {
    renderAt('/')
    expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeInTheDocument()
  })

  it('renders the order blotter at /orders', () => {
    renderAt('/orders')
    expect(screen.getByRole('heading', { name: 'Order Blotter' })).toBeInTheDocument()
  })

  it('renders the sidebar navigation on every page', () => {
    renderAt('/portfolio')
    expect(screen.getByText('Trading Platform')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Dashboard/ })).toBeInTheDocument()
  })

  it('falls back gracefully (no route match renders no page content, not a crash)', () => {
    renderAt('/does-not-exist')
    // Sidebar still renders even when no Route matches the current path.
    expect(screen.getByText('Trading Platform')).toBeInTheDocument()
  })
})
