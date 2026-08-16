import 'dotenv/config'
import { createApp, DEFAULT_ORIGINS } from './app.js'
import { openDatabase, initSchema } from './db/duckdb.js'
import { enableDefaultMetrics } from './metrics/registry.js'
import { createLifecycle } from './lifecycle.js'
import { createPostgres } from './db/postgres.js'
import { migrate } from './db/migrate.js'
import { loadConfig, ConfigError } from './config.js'
import { createLogger } from './lib/logger.js'

// Validate everything before opening a file handle or a socket. A misconfigured process that
// starts and looks healthy is worse than one that refuses to, so this exits non-zero with
// every problem listed at once rather than one restart per mistake.
let config
try {
  config = loadConfig(process.env, { defaultOrigins: DEFAULT_ORIGINS })
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message)
    process.exit(78) // EX_CONFIG, the conventional exit code for a bad configuration
  }
  throw err
}

const logger = createLogger({ level: config.logLevel, format: config.logFormat })

// Node process metrics (CPU, memory, event-loop lag, GC) — started here rather than in
// createApp so importing the app under test doesn't install process-wide collectors.
enableDefaultMetrics()

const db = openDatabase(config.dbPath)
await initSchema(db)

// The transactional store. Optional outside production, because the market-data, replay and
// analytics surfaces predate the order domain and still work without it — the order routes
// are the part that needs it, and they say so rather than the whole process refusing to boot.
let pg = null
if (config.databaseUrl) {
  pg = createPostgres({
    connectionString: config.databaseUrl,
    max: config.pgPoolMax,
    logger,
  })
  // Migrate before listening. A process that accepts traffic against a schema it has not
  // finished migrating will fail requests in ways that look like bugs in the routes.
  await migrate(pg, { logger })
} else {
  logger.warn('DATABASE_URL is not set — the order domain is unavailable', {
    affected: '/api/orders',
  })
}

// Installed before the listener exists: a crash during boot should still close the database.
const lifecycle = createLifecycle({
  db,
  extraClosers: pg ? [() => pg.close()] : [],
  drainMs: config.drainMs,
  shutdownTimeoutMs: config.shutdownTimeoutMs,
  log: {
    log: (msg) => logger.info(msg),
    error: (msg, err) => logger.error(msg, { err }),
  },
})
lifecycle.install()

const app = createApp(db, {
  apiKey: config.apiKey,
  corsOrigins: config.corsOrigins,
  jsonLimit: config.jsonLimit,
  trustProxy: config.trustProxy,
  isDraining: lifecycle.isDraining,
  logger,
  pg,
})

const server = app.listen(config.port, () => {
  logger.info('backend listening', {
    port: config.port,
    dbPath: config.dbPath,
    corsOrigins: config.corsOrigins,
    env: config.nodeEnv,
    metrics: `http://localhost:${config.port}/metrics`,
  })
  if (config.generatedKey) {
    // Deliberately on the console rather than the structured log: it is a one-time
    // instruction to the operator watching the terminal, not an event worth shipping.
    console.log(
      `\nNo API_KEY set — generated one for this run:\n  API_KEY=${config.generatedKey}\n` +
        `Put it in backend/.env and as VITE_API_KEY in frontend/.env to keep it across restarts.\n`,
    )
  } else {
    logger.info('API key authentication enabled (API_KEY from the environment)')
  }
})

lifecycle.attach(server)

// A port already in use is the everyday startup failure, and Node's default for it is an
// unhandled 'error' event. Name it, then leave through the same shutdown path as anything else.
server.on('error', (err) => {
  if (err?.code === 'EADDRINUSE') {
    logger.error('port already in use; set PORT (and DUCKDB_PATH) to move', { port: config.port })
  } else {
    logger.error('HTTP server error', { err })
  }
  lifecycle.shutdown('listen-error', 1)
})
