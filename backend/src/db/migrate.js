/**
 * Schema migrations: numbered SQL files, applied in order, exactly once, ever.
 *
 * Why a runner rather than `CREATE TABLE IF NOT EXISTS` at boot, which is what the DuckDB
 * side does: bars can be dropped and refetched, so an idempotent bootstrap is fine there.
 * Orders cannot. Once a row exists, the only safe way to change the shape around it is a
 * recorded, ordered, one-time script — otherwise "which version is this database?" has no
 * answer and every deployment is a guess.
 *
 * Three properties this gives up nothing to get:
 *
 *  - **The whole run is one transaction.** Postgres has transactional DDL, so a failure in
 *    migration 7 rolls back 5 and 6 with it and the database stays on the last version that
 *    fully applied. Never half a schema change.
 *  - **An advisory lock guards the run.** Two instances booting at once — the normal case
 *    behind a load balancer, and the *guaranteed* case during a rolling deploy — would
 *    otherwise both see version 3 and both try to apply 4. The lock is transaction-scoped,
 *    so it is released even if the process dies mid-migration.
 *  - **Applied files are checksummed.** Editing a migration that has already run is a
 *    mistake that produces two databases with the same version number and different schemas,
 *    so it fails loudly instead of being ignored.
 */
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Arbitrary but fixed: the key two instances contend on. Changing it defeats the lock. */
const ADVISORY_LOCK_KEY = 4_120_251

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations')

function checksum(sql) {
  // Line endings are normalized first: a file checked out with CRLF on Windows and LF in CI
  // is the same migration, and a checksum that disagrees would block every deployment.
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex')
}

/** `001_orders.sql` → `{ version: 1, name: '001_orders.sql' }`, sorted by version. */
export async function listMigrations(dir = MIGRATIONS_DIR) {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql'))
  const migrations = []
  for (const name of files) {
    const match = /^(\d+)[_-]/.exec(name)
    if (!match) throw new Error(`Migration "${name}" must start with a number, e.g. 001_name.sql`)
    migrations.push({ version: Number(match[1]), name, path: join(dir, name) })
  }
  migrations.sort((a, b) => a.version - b.version)

  const seen = new Set()
  for (const m of migrations) {
    if (seen.has(m.version)) throw new Error(`Duplicate migration version ${m.version}`)
    seen.add(m.version)
  }
  return migrations
}

/**
 * Apply every migration the database has not seen.
 *
 * @param {object} db the Postgres handle from `createPostgres`
 * @param {object} [options]
 * @param {string} [options.dir] directory of .sql files
 * @param {object} [options.logger] structured logger
 * @returns {Promise<string[]>} the names actually applied, in order
 */
export async function migrate(db, { dir = MIGRATIONS_DIR, logger = console } = {}) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INTEGER     PRIMARY KEY,
      name        TEXT        NOT NULL,
      checksum    TEXT        NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)

  const migrations = await listMigrations(dir)
  const applied = []

  // One session holds the lock for the whole run; everyone else waits here and then finds
  // there is nothing left to do. Released automatically if the process dies holding it.
  await db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [ADVISORY_LOCK_KEY])

    const rows = await tx.query('SELECT version, name, checksum FROM schema_migrations')
    const known = new Map(rows.map((r) => [Number(r.version), r]))

    for (const migration of migrations) {
      const sql = await readFile(migration.path, 'utf8')
      const hash = checksum(sql)
      const previous = known.get(migration.version)

      if (previous) {
        if (previous.checksum !== hash) {
          throw new Error(
            `Migration ${migration.name} was modified after being applied. ` +
              'An already-applied migration must never change — add a new one instead, or ' +
              'two databases will report the same version with different schemas.',
          )
        }
        continue
      }

      logger.info?.('applying migration', { version: migration.version, name: migration.name })
      await tx.query(sql)
      await tx.query(
        'INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
        [migration.version, migration.name, hash],
      )
      applied.push(migration.name)
    }
  })

  if (applied.length === 0) logger.info?.('schema up to date')
  else logger.info?.('migrations applied', { count: applied.length, applied })
  return applied
}
