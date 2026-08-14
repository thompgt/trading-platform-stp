import { describe, it, expect } from 'vitest'
import { loadConfig, ConfigError } from '../src/config.js'

const DEFAULTS = ['http://localhost:5173']

/** A configuration that is valid, so each test can invalidate exactly one thing. */
function env(overrides = {}) {
  return { API_KEY: 'a-sufficiently-long-key', ...overrides }
}

function load(overrides, options = {}) {
  return loadConfig(env(overrides), { defaultOrigins: DEFAULTS, ...options })
}

describe('loadConfig', () => {
  it('applies documented defaults when nothing is set', () => {
    const config = load()
    expect(config).toMatchObject({
      port: 4000,
      dbPath: './data/market.duckdb',
      jsonLimit: '2mb',
      trustProxy: 0,
      drainMs: 5000,
      shutdownTimeoutMs: 15_000,
      corsOrigins: DEFAULTS,
    })
  })

  it('rejects a port that is not a number, rather than listening on a random one', () => {
    expect(() => load({ PORT: 'eight thousand' })).toThrow(/PORT must be a whole number/)
    expect(() => load({ PORT: '0' })).toThrow(/PORT must be between/)
    expect(() => load({ PORT: '70000' })).toThrow(/PORT must be between/)
  })

  it('rejects a non-numeric drain, which would silently skip the drain entirely', () => {
    expect(() => load({ SHUTDOWN_DRAIN_MS: 'abc' })).toThrow(/whole number/)
  })

  it('rejects a drain that cannot finish before the shutdown deadline', () => {
    expect(() => load({ SHUTDOWN_DRAIN_MS: '20000', SHUTDOWN_TIMEOUT_MS: '15000' })).toThrow(
      /must be below SHUTDOWN_TIMEOUT_MS/,
    )
  })

  it('reports every problem at once, so one restart shows them all', () => {
    try {
      load({ PORT: 'nope', LOG_LEVEL: 'chatty', LOG_FORMAT: 'xml' })
      throw new Error('expected a ConfigError')
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError)
      expect(err.problems).toHaveLength(3)
    }
  })

  it('mints an API key outside production, and refuses to in production', () => {
    const dev = load({ API_KEY: undefined }, { generateKey: () => 'minted-key' })
    expect(dev.apiKey).toBe('minted-key')
    expect(dev.generatedKey).toBe('minted-key')

    expect(() =>
      load({ API_KEY: undefined, NODE_ENV: 'production' }, { generateKey: () => 'minted-key' }),
    ).toThrow(/must be set explicitly in production/)
  })

  it('refuses a placeholder or too-short API key', () => {
    expect(() => load({ API_KEY: 'change-me-to-a-long-random-string' })).toThrow(/placeholder/)
    expect(() => load({ API_KEY: 'short' })).toThrow(/at least 16 characters/)
  })

  it('validates the log level and format', () => {
    expect(() => load({ LOG_LEVEL: 'chatty' })).toThrow(/LOG_LEVEL must be one of/)
    expect(() => load({ LOG_FORMAT: 'xml' })).toThrow(/LOG_FORMAT must be/)
    expect(load({ LOG_LEVEL: 'debug', LOG_FORMAT: 'pretty' })).toMatchObject({
      logLevel: 'debug',
      logFormat: 'pretty',
    })
  })

  it('normalizes origins to their canonical form', () => {
    expect(load({ CORS_ORIGIN: 'https://ops.example.com:443' }).corsOrigins).toEqual([
      'https://ops.example.com',
    ])
  })

  it('bounds the trusted proxy hop count', () => {
    expect(load({ TRUST_PROXY: '2' }).trustProxy).toBe(2)
    expect(() => load({ TRUST_PROXY: '-1' })).toThrow(/between/)
  })
})
