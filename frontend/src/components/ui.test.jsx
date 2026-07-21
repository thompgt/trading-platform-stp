import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Card, Badge, StatTile } from './ui.jsx'

describe('Card', () => {
  it('renders title, subtitle, and children', () => {
    render(
      <Card title="Positions" subtitle="Live from Portfolio Agent">
        <p>body content</p>
      </Card>,
    )
    expect(screen.getByRole('heading', { name: 'Positions' })).toBeInTheDocument()
    expect(screen.getByText('Live from Portfolio Agent')).toBeInTheDocument()
    expect(screen.getByText('body content')).toBeInTheDocument()
  })

  it('renders without a header when no title/subtitle given', () => {
    render(<Card>just content</Card>)
    expect(screen.queryByRole('heading')).not.toBeInTheDocument()
  })
})

describe('Badge', () => {
  it('falls back to the neutral tone for an unknown status', () => {
    render(<Badge status="totally-unknown-status">Weird</Badge>)
    const badge = screen.getByText('Weird')
    expect(badge.className).toContain('tone-neutral')
  })

  it('maps known statuses to the expected tone', () => {
    render(<Badge status="high">Alert</Badge>)
    expect(screen.getByText('Alert').className).toContain('tone-bad')
  })

  it('renders the status itself when no children are given', () => {
    render(<Badge status="healthy" />)
    expect(screen.getByText('healthy')).toBeInTheDocument()
  })
})

describe('StatTile', () => {
  it('renders label, value, and optional delta', () => {
    render(<StatTile label="Open Orders" value="4" delta="1 pending" />)
    expect(screen.getByText('Open Orders')).toBeInTheDocument()
    expect(screen.getByText('4')).toBeInTheDocument()
    expect(screen.getByText('1 pending')).toBeInTheDocument()
  })

  it('omits the delta row when none is given', () => {
    render(<StatTile label="Positions" value="5" />)
    expect(screen.queryByText(/pending/)).not.toBeInTheDocument()
  })
})
