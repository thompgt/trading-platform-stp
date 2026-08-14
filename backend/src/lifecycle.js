/**
 * Orderly startup-to-shutdown handling for the backend process.
 *
 * Without this, a container stop is a `SIGTERM` that Node turns into an immediate exit: every
 * in-flight request is severed mid-response and the DuckDB handle is never closed, which for
 * a file-backed database means the write-ahead log is left for the next process to replay.
 * On a platform that serves ledgers and settlement runs that is the wrong default.
 *
 * The sequence, in order, and why each step exists:
 *
 *   1. Flip to draining. `/api/ready` starts answering 503 while `/api/health` keeps saying
 *      yes, so a load balancer deregisters this instance but nothing restarts it.
 *   2. Wait `drainMs`. This is the window the balancer needs to notice. Skipping it is the
 *      most common cause of "we drained gracefully and still dropped requests" — the socket
 *      closes before the routing layer has stopped choosing this instance.
 *   3. Stop accepting new connections and let in-flight requests finish.
 *   4. Close the database.
 *   5. Exit 0.
 *
 * A hard deadline sits over the whole thing: if any step hangs past `shutdownTimeoutMs` the
 * process force-exits non-zero rather than lingering as an undead instance an orchestrator
 * has to SIGKILL.
 *
 * The clock and the exit are injected so the sequence can be tested without a real process.
 */

const DEFAULT_DRAIN_MS = 5_000
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 15_000

/**
 * @param {object} options
 * @param {object} options.db open DuckDB handle, closed during shutdown
 * @param {number} [options.drainMs] time spent reporting not-ready before closing the listener
 * @param {number} [options.shutdownTimeoutMs] hard deadline for the whole sequence
 * @param {object} [options.log] console-shaped logger
 * @param {(code: number) => void} [options.exit] process exit, injected for tests
 * @param {(ms: number) => Promise<void>} [options.wait] sleep, injected for tests
 */
export function createLifecycle({
  db,
  drainMs = DEFAULT_DRAIN_MS,
  shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
  log = console,
  exit = (code) => process.exit(code),
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  let draining = false
  let server = null
  let inFlight = null

  /** True from the moment shutdown begins; read by the readiness probe. */
  const isDraining = () => draining

  /** Hand over the HTTP server once it is listening, so shutdown can close it. */
  function attach(httpServer) {
    server = httpServer
  }

  function closeServer() {
    if (!server) return Promise.resolve()
    return new Promise((resolve) => {
      // Idle keep-alive sockets hold `close` open until their timeout, which can be far
      // longer than the drain window; closing them first is what makes step 3 finish.
      server.closeIdleConnections?.()
      server.close(() => resolve())
    })
  }

  async function sequence(reason) {
    log.log?.(`Shutting down (${reason}); draining for ${drainMs}ms`)
    draining = true
    await wait(drainMs)

    await closeServer()
    log.log?.('HTTP listener closed; closing the database')

    try {
      await db?.close?.()
    } catch (err) {
      // A failed close is worth reporting but not worth blocking the exit on — the process
      // is going away, and DuckDB recovers its WAL on the next open.
      log.error?.('Failed to close the database cleanly', err)
    }
    log.log?.('Shutdown complete')
  }

  /**
   * Run the shutdown sequence. Idempotent: a second signal returns the in-flight promise
   * rather than starting a competing teardown.
   */
  function shutdown(reason = 'requested', code = 0) {
    if (inFlight) return inFlight

    let timer = null
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => {
        log.error?.(`Shutdown exceeded ${shutdownTimeoutMs}ms; forcing exit`)
        // Whatever is still holding a socket does not get to outlive the deadline.
        server?.closeAllConnections?.()
        exit(1)
        resolve()
      }, shutdownTimeoutMs)
      timer.unref?.()
    })

    inFlight = Promise.race([sequence(reason), deadline]).then(() => {
      clearTimeout(timer)
      exit(code)
    })
    return inFlight
  }

  /**
   * Wire the process-level events. `uncaughtException` and `unhandledRejection` exit
   * non-zero after the same drain: an unknown-state process should be replaced, but it
   * should still let the requests it is already holding finish first.
   */
  function install(proc = process) {
    proc.on('SIGTERM', () => shutdown('SIGTERM'))
    proc.on('SIGINT', () => shutdown('SIGINT'))
    proc.on('uncaughtException', (err) => {
      log.error?.('Uncaught exception', err)
      shutdown('uncaughtException', 1)
    })
    proc.on('unhandledRejection', (err) => {
      log.error?.('Unhandled rejection', err)
      shutdown('unhandledRejection', 1)
    })
  }

  return { isDraining, attach, shutdown, install }
}
