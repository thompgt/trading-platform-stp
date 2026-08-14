/**
 * A minimal structured logger — one JSON object per line, no dependency.
 *
 * The platform already emits metrics, which tell you *that* something is failing. Logs have
 * to answer *which request* failed and *why*, and `console.log` of an interpolated sentence
 * cannot be filtered by status, grouped by route, or joined to the request the user is
 * complaining about. One JSON line per event can be, by anything from `jq` to a log backend,
 * without a parsing rule per message.
 *
 * `LOG_FORMAT=pretty` switches to a human line for local work, where a wall of JSON is worse
 * than the thing it replaced. `LOG_LEVEL` filters; `silent` is what tests use so a suite that
 * deliberately triggers failures doesn't print a hundred lines of expected noise.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 }

/** Keys whose values are credentials or free-text prompts; never written to a log line. */
const REDACTED = new Set(['apikey', 'api_key', 'authorization', 'x-api-key', 'key', 'token'])

/** Replace credential-shaped values with a marker, at any depth of the logged object. */
export function redact(value) {
  if (Array.isArray(value)) return value.map(redact)
  if (!value || typeof value !== 'object') return value
  const out = {}
  for (const [key, inner] of Object.entries(value)) {
    out[key] = REDACTED.has(key.toLowerCase()) ? '[redacted]' : redact(inner)
  }
  return out
}

/** Errors do not survive JSON.stringify — pull out the parts worth keeping. */
function serializeError(err) {
  if (!(err instanceof Error)) return err
  return {
    name: err.name,
    message: err.message,
    stack: err.stack,
    ...(err.cause ? { cause: serializeError(err.cause) } : {}),
  }
}

/**
 * @param {object} [options]
 * @param {string} [options.level] minimum level to emit; `silent` drops everything
 * @param {'json'|'pretty'} [options.format] line shape
 * @param {(line: string) => void} [options.write] sink, injected for tests
 * @param {() => string} [options.now] timestamp source, injected for tests
 */
export function createLogger({
  // Silent under test unless asked otherwise: a suite that deliberately provokes failures
  // would otherwise bury its own output in expected error lines.
  level = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
  format = process.env.LOG_FORMAT || 'json',
  write = (line) => process.stdout.write(`${line}\n`),
  now = () => new Date().toISOString(),
} = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info

  function emit(levelName, message, fields = {}) {
    if (LEVELS[levelName] < threshold) return
    const { err, ...rest } = fields
    const record = {
      time: now(),
      level: levelName,
      msg: message,
      ...redact(rest),
      ...(err ? { err: serializeError(err) } : {}),
    }
    if (format === 'pretty') {
      const extras = Object.entries(record)
        .filter(([key]) => !['time', 'level', 'msg'].includes(key))
        .map(([key, val]) => `${key}=${typeof val === 'object' ? JSON.stringify(val) : val}`)
        .join(' ')
      write(`${record.time} ${levelName.toUpperCase()} ${message}${extras ? ` ${extras}` : ''}`)
      return
    }
    write(JSON.stringify(record))
  }

  return {
    level,
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    /** A logger that stamps every line with the same fields — used to bind a request id. */
    child: (bound) => {
      const parent = { emit }
      const wrap = (levelName) => (msg, fields) =>
        parent.emit(levelName, msg, { ...bound, ...fields })
      return {
        level,
        debug: wrap('debug'),
        info: wrap('info'),
        warn: wrap('warn'),
        error: wrap('error'),
        child: (more) => createLogger({ level, format, write, now }).child({ ...bound, ...more }),
      }
    },
  }
}

/** The process-wide logger. Tests construct their own rather than using this one. */
export const logger = createLogger()
