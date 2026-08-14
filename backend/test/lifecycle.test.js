import { describe, it, expect, vi } from 'vitest'
import { createLifecycle } from '../src/lifecycle.js'

/** A logger that swallows output but records that it was called. */
function fakeLog() {
  return { log: vi.fn(), error: vi.fn() }
}

/** A server stub whose `close` callback fires only when we say so. */
function fakeServer() {
  let finish
  return {
    closeIdleConnections: vi.fn(),
    closeAllConnections: vi.fn(),
    close: vi.fn((cb) => {
      finish = cb
    }),
    finishClosing: () => finish?.(),
  }
}

describe('createLifecycle', () => {
  it('drains, closes the server, closes the db, then exits 0', async () => {
    const order = []
    const db = { close: vi.fn(async () => order.push('db')) }
    const exit = vi.fn((code) => order.push(`exit:${code}`))
    const wait = vi.fn(async () => order.push('drain'))
    const server = fakeServer()
    server.close.mockImplementation((cb) => {
      order.push('server')
      cb()
    })

    const lifecycle = createLifecycle({ db, exit, wait, log: fakeLog(), drainMs: 50 })
    lifecycle.attach(server)
    await lifecycle.shutdown('SIGTERM')

    expect(order).toEqual(['drain', 'server', 'db', 'exit:0'])
    expect(wait).toHaveBeenCalledWith(50)
    expect(server.closeIdleConnections).toHaveBeenCalled()
  })

  it('reports not-ready as soon as shutdown starts, not when it finishes', async () => {
    const db = { close: vi.fn(async () => {}) }
    const lifecycle = createLifecycle({
      db,
      exit: vi.fn(),
      log: fakeLog(),
      // Observe the flag partway through the drain, before anything has closed.
      wait: async () => expect(lifecycle.isDraining()).toBe(true),
    })

    expect(lifecycle.isDraining()).toBe(false)
    await lifecycle.shutdown('SIGTERM')
    expect(lifecycle.isDraining()).toBe(true)
  })

  it('is idempotent: a second signal joins the first teardown', async () => {
    const db = { close: vi.fn(async () => {}) }
    const exit = vi.fn()
    const lifecycle = createLifecycle({ db, exit, wait: async () => {}, log: fakeLog() })

    await Promise.all([lifecycle.shutdown('SIGTERM'), lifecycle.shutdown('SIGINT')])

    expect(db.close).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledTimes(1)
  })

  it('carries the requested exit code, so a crash exits non-zero', async () => {
    const exit = vi.fn()
    const lifecycle = createLifecycle({
      db: { close: vi.fn(async () => {}) },
      exit,
      wait: async () => {},
      log: fakeLog(),
    })

    await lifecycle.shutdown('uncaughtException', 1)
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('force-exits non-zero when a step hangs past the deadline', async () => {
    vi.useFakeTimers()
    try {
      const exit = vi.fn()
      const log = fakeLog()
      const server = fakeServer() // close() never calls back
      const lifecycle = createLifecycle({
        db: { close: vi.fn(async () => {}) },
        exit,
        log,
        wait: async () => {},
        shutdownTimeoutMs: 1000,
      })
      lifecycle.attach(server)

      lifecycle.shutdown('SIGTERM')
      await vi.advanceTimersByTimeAsync(1500)

      expect(exit).toHaveBeenCalledWith(1)
      expect(server.closeAllConnections).toHaveBeenCalled()
      expect(log.error).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('exits cleanly even when closing the database fails', async () => {
    const exit = vi.fn()
    const log = fakeLog()
    const lifecycle = createLifecycle({
      db: { close: vi.fn(async () => Promise.reject(new Error('locked'))) },
      exit,
      log,
      wait: async () => {},
    })

    await lifecycle.shutdown('SIGTERM')
    expect(exit).toHaveBeenCalledWith(0)
    expect(log.error).toHaveBeenCalled()
  })

  it('installs handlers for the signals and the two crash events', () => {
    const on = vi.fn()
    const lifecycle = createLifecycle({ db: { close: vi.fn() }, exit: vi.fn(), log: fakeLog() })
    lifecycle.install({ on })

    const events = on.mock.calls.map(([event]) => event)
    expect(events).toEqual([
      'SIGTERM',
      'SIGINT',
      'uncaughtException',
      'unhandledRejection',
    ])
  })
})
