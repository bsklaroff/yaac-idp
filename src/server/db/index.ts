/**
 * The issuer's database: PGlite, a Postgres that runs inside this process,
 * over a data directory only one process may open.
 */
import { existsSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'

export const MIGRATIONS_DIR = path.resolve(import.meta.dirname, '../../../drizzle')

/** Opens the database at `dataDir`, or one in memory when it is omitted. */
export function openDb(dataDir?: string) {
  const client = new PGlite(dataDir)
  return Object.assign(drizzle({ client }), { $client: client })
}

export type Db = ReturnType<typeof openDb>

export async function applyMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR })
}

/**
 * Brings the database at `dataDir` up to the checked-in schema. Nothing else
 * may have it open, which makes the dump it first writes to `dumpPath` a
 * consistent copy of the database as the migrations found it.
 *
 * The dump is written beside `dumpPath` and renamed over it, so a write cut
 * short leaves the previous dump whole. It holds the whole database, so only
 * the issuer's user may read it.
 */
export async function migrateDataDir(dataDir: string, dumpPath: string): Promise<void> {
  const existed = existsSync(dataDir)
  await mkdir(path.dirname(dataDir), { recursive: true })
  const db = openDb(dataDir)
  try {
    if (existed) {
      // A dump asked for while the database is still starting never ends.
      await db.$client.waitReady
      const dump = await db.$client.dumpDataDir('gzip')
      await writeFile(`${dumpPath}.tmp`, Buffer.from(await dump.arrayBuffer()), { mode: 0o600 })
      await rename(`${dumpPath}.tmp`, dumpPath)
    }
    await applyMigrations(db)
  } finally {
    await db.$client.close()
  }
}
