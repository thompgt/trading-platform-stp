/**
 * Boot-time configuration: read the environment once, validate it, and refuse to start on
 * anything that would fail later or fail silently.
 *
 * The failure this prevents is the expensive kind. `PORT=eight thousand` becomes `NaN` and
 * Express listens on a random port. `SHUTDOWN_DRAIN_MS=abc` becomes `NaN` and the drain
 * `setTimeout` fires immediately, so the graceful shutdown quietly stops being graceful.
 * `CORS_ORIGIN=*` used to be dropped in silence, leaving an operator convinced they opened
 * the API to a domain that is in fact rejected. Every one of those starts a process that
 * looks healthy and is not, which is strictly worse than not starting.
 *
 * So: parse here, once, with a reason attached to every rejection, and hand the rest of the
 * app values it can trust. Everything is read through `env` rather than `process.env` so a
 * test can supply a configuration without mutating the process.
 */
import { randomBytes } from 'node:crypto'

/** The smallest API key we will accept from an operator, in characters. */
const MIN_API_KEY_LENGTH = 16

/** Placeholder keys shipped in .env.example — a real deployment must not run on one. */
const PLACEHOLDER_KEYS = new Set(['change-me-to-a-long-random-string', 'changeme', 'secret'])

class ConfigError extends Error {
  constructor(problems) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`)
    this.name = 'ConfigError'
    this.problems = problems
  }
}

/** Parse an integer that must be present and sane, collecting a reason rather than throwing. */
function readInt(env, name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER }, problems) {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value)) {
    problems.push(`${name} must be a whole number, got "${raw}"`)
    return fallback
  }
  if (value < min || value > max) {
    problems.push(`${name} must be between ${min} and ${max}, got ${value}`)
    return fallback
  }
  return value
}

/** `CORS_ORIGIN` entries must be real origins: scheme and host, no path, no wildcard. */
function readOrigins(env, defaults, problems) {
  const raw = env.CORS_ORIGIN
  if (!raw) return defaults

  const entries = raw
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)
  const origins = []
  for (const entry of entries) {
    if (entry === '*') {
      problems.push(
        'CORS_ORIGIN cannot be "*": this API proxies a paid LLM key and serves ledgers, ' +
          'so any page on the internet would be able to spend the operator\'s money',
      )
      continue
    }
    let url
    try {
      url = new URL(entry)
    } catch {
      problems.push(`CORS_ORIGIN entry "${entry}" is not a URL (expected e.g. https://app.example.com)`)
      continue
    }
    if (url.pathname !== '/' || url.search || url.hash) {
      problems.push(`CORS_ORIGIN entry "${entry}" must be an origin only, with no path or query`)
      continue
    }
    origins.push(url.origin)
  }
  return origins.length > 0 ? origins : defaults
}

/**
 * Read and validate the whole configuration.
 *
 * @param {object} [env] environment to read; defaults to the process environment
 * @param {object} [options]
 * @param {string[]} [options.defaultOrigins] CORS allowlist used when none is configured
 * @param {() => string} [options.generateKey] API-key source, injected for tests
 * @throws {ConfigError} listing every problem at once, so one restart shows them all
 */
export function loadConfig(env = process.env, { defaultOrigins = [], generateKey } = {}) {
  const problems = []
  const mintKey = generateKey ?? (() => randomBytes(24).toString('hex'))
  const nodeEnv = env.NODE_ENV || 'development'
  const isProduction = nodeEnv === 'production'

  // An unset key is minted and printed rather than starting open (see middleware/auth.js).
  // A *set* key still has to be worth having: a short or placeholder one is the same hole
  // with a false sense of security, and in production it is a hard failure.
  const suppliedKey = env.API_KEY?.trim()
  let apiKey = suppliedKey || null
  let generatedKey = null
  if (!suppliedKey) {
    if (isProduction) {
      problems.push('API_KEY must be set explicitly in production, not generated at boot')
    }
    generatedKey = mintKey()
    apiKey = generatedKey
  } else if (PLACEHOLDER_KEYS.has(suppliedKey)) {
    problems.push('API_KEY is still the placeholder from .env.example; set a real random value')
  } else if (suppliedKey.length < MIN_API_KEY_LENGTH) {
    problems.push(`API_KEY must be at least ${MIN_API_KEY_LENGTH} characters`)
  }

  const logLevel = env.LOG_LEVEL || (nodeEnv === 'test' ? 'silent' : 'info')
  if (!['debug', 'info', 'warn', 'error', 'silent'].includes(logLevel)) {
    problems.push(`LOG_LEVEL must be one of debug|info|warn|error|silent, got "${logLevel}"`)
  }
  const logFormat = env.LOG_FORMAT || 'json'
  if (!['json', 'pretty'].includes(logFormat)) {
    problems.push(`LOG_FORMAT must be json or pretty, got "${logFormat}"`)
  }

  const config = {
    nodeEnv,
    isProduction,
    port: readInt(env, 'PORT', 4000, { min: 1, max: 65535 }, problems),
    dbPath: env.DUCKDB_PATH || './data/market.duckdb',
    apiKey,
    generatedKey,
    corsOrigins: readOrigins(env, defaultOrigins, problems),
    jsonLimit: env.JSON_BODY_LIMIT || '2mb',
    trustProxy: readInt(env, 'TRUST_PROXY', 0, { min: 0, max: 10 }, problems),
    logLevel,
    logFormat,
    // A drain of zero is legitimate (single instance, no balancer) so the floor is 0, but a
    // drain longer than the shutdown deadline can never complete, which is checked below.
    drainMs: readInt(env, 'SHUTDOWN_DRAIN_MS', 5000, { min: 0, max: 120_000 }, problems),
    shutdownTimeoutMs: readInt(env, 'SHUTDOWN_TIMEOUT_MS', 15_000, { min: 1000, max: 300_000 }, problems),
    groqApiKey: env.GROQ_API_KEY || null,
    // The transactional store for the order domain. DuckDB stays the analytical store, so
    // this is a second connection rather than a replacement — see db/postgres.js.
    databaseUrl: env.DATABASE_URL || null,
    pgPoolMax: readInt(env, 'PG_POOL_MAX', 10, { min: 1, max: 100 }, problems),
  }

  if (config.databaseUrl) {
    let url
    try {
      url = new URL(config.databaseUrl)
    } catch {
      url = null
      problems.push('DATABASE_URL is not a valid connection URL (postgres://user:pass@host/db)')
    }
    if (url && !['postgres:', 'postgresql:'].includes(url.protocol)) {
      problems.push(`DATABASE_URL must be a postgres:// URL, got "${url.protocol}//"`)
    }
  } else if (config.isProduction) {
    // Outside production the app still runs without it — the market-data, replay and
    // analytics surfaces predate the order domain and do not need it. In production, a
    // missing DATABASE_URL means the order routes 503 on every call, which is not a state
    // worth booting into.
    problems.push('DATABASE_URL must be set in production; the order domain requires Postgres')
  }

  if (config.drainMs >= config.shutdownTimeoutMs) {
    problems.push(
      `SHUTDOWN_DRAIN_MS (${config.drainMs}) must be below SHUTDOWN_TIMEOUT_MS ` +
        `(${config.shutdownTimeoutMs}), or the deadline fires before the drain ends`,
    )
  }

  if (problems.length > 0) throw new ConfigError(problems)
  return config
}

export { ConfigError }
