import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import ErrorBoundary from './ErrorBoundary.jsx'

function Bomb({ shouldThrow }) {
  if (shouldThrow) {
    throw new Error('boom')
  }
  return <div>safe content</div>
}

describe('ErrorBoundary', () => {
  let consoleErrorSpy

  beforeEach(() => {
    // React logs the caught error to console.error too; keep test output clean.
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleErrorSpy.mockRestore()
  })

  it('renders children when nothing throws', () => {
    render(
      <ErrorBoundary>
        <Bomb shouldThrow={false} />
      </ErrorBoundary>,
    )
    expect(screen.getByText('safe content')).toBeInTheDocument()
  })

  it('renders a fallback UI instead of crashing when a child throws', () => {
    render(
      <ErrorBoundary>
        <Bomb shouldThrow={true} />
      </ErrorBoundary>,
    )
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByText('boom')).toBeInTheDocument()
  })

  it('lets the user retry, re-mounting the children', () => {
    let shouldThrow = true
    function Wrapper() {
      return (
        <ErrorBoundary>
          <Bomb shouldThrow={shouldThrow} />
        </ErrorBoundary>
      )
    }

    const { rerender } = render(<Wrapper />)
    expect(screen.getByRole('alert')).toBeInTheDocument()

    // The boundary's `children` prop only changes when its parent re-renders, so update
    // the underlying condition and re-render *before* resetting the boundary's own state.
    shouldThrow = false
    rerender(<Wrapper />)
    fireEvent.click(screen.getByRole('button', { name: /try again/i }))

    expect(screen.getByText('safe content')).toBeInTheDocument()
  })
})
