/**
 * A Map with a TTL and a hard entry cap.
 *
 * Both in-memory stores in this backend — replay sessions and settlement runs — pin real
 * memory per entry (a whole bar array, a whole ledger) and had no expiry and no delete. A
 * loop against /api/simulation/start would grow the process until it died, which is a
 * denial-of-service in one line of curl. This bounds both dimensions: entries expire after
 * `ttlMs` of no access, and the store never holds more than `maxEntries`.
 *
 * Eviction is least-recently-used, and "used" means read as well as written: an idle session
 * is the right one to drop, an actively stepped one is not. JS Maps iterate in insertion
 * order, so re-inserting on access moves an entry to the back and makes the first key the
 * least-recently-used one.
 */
export class ExpiringStore {
  /**
   * @param {object} [options]
   * @param {number} [options.ttlMs] idle time before an entry expires; defaults to an hour
   * @param {number} [options.maxEntries] hard cap; the LRU entry is dropped past it
   * @param {(key: string, value: any) => void} [options.onEvict] called for each removal
   */
  constructor({ ttlMs = 60 * 60 * 1000, maxEntries = 200, onEvict = null } = {}) {
    this.ttlMs = ttlMs
    this.maxEntries = maxEntries
    this.onEvict = onEvict
    this.entries = new Map()
  }

  /** Drop everything past its TTL. Called on every read and write — no timer to leak. */
  sweep(now = Date.now()) {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key)
        this.onEvict?.(key, entry.value)
      }
    }
  }

  set(key, value) {
    const now = Date.now()
    this.sweep(now)
    this.entries.delete(key)
    this.entries.set(key, { value, expiresAt: now + this.ttlMs })

    // Cap after inserting, so a fresh entry is never rejected in favour of an older one.
    while (this.entries.size > this.maxEntries) {
      const [oldestKey, oldest] = this.entries.entries().next().value
      this.entries.delete(oldestKey)
      this.onEvict?.(oldestKey, oldest.value)
    }
    return value
  }

  /** Read and renew. Returns undefined for a missing or expired key. */
  get(key) {
    const now = Date.now()
    this.sweep(now)
    const entry = this.entries.get(key)
    if (!entry) return undefined
    entry.expiresAt = now + this.ttlMs
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  has(key) {
    return this.get(key) !== undefined
  }

  delete(key) {
    const entry = this.entries.get(key)
    if (!entry) return false
    this.entries.delete(key)
    this.onEvict?.(key, entry.value)
    return true
  }

  get size() {
    this.sweep()
    return this.entries.size
  }

  /** Live [key, value] pairs, oldest first — expired entries are swept out first. */
  *[Symbol.iterator]() {
    this.sweep()
    for (const [key, entry] of this.entries) yield [key, entry.value]
  }

  /** Test-only reset, so a module-level store does not carry state between cases. */
  clear() {
    this.entries.clear()
  }
}
