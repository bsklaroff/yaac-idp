import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { expect, test } from 'vitest'
import { migrateDataDir, openDb } from '#server/db/index.ts'
import { users } from '#server/db/schema.ts'

// Real PGlite on disk: six opens of a Postgres data directory.
test('migrateDataDir creates the schema, then dumps what it finds before migrating again', { timeout: 90_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yaac-idp-'))
  const dataDir = path.join(root, 'volume', 'pg')
  const dumpPath = path.join(root, 'volume', 'dump.tar.gz')
  try {
    await migrateDataDir(dataDir, dumpPath)
    await expect(readFile(dumpPath)).rejects.toThrow()

    const db = openDb(dataDir)
    await db.insert(users).values({ id: 'u1', name: 'Alice', email: 'alice@example.com' })
    await db.$client.close()

    await migrateDataDir(dataDir, dumpPath)
    const emailsIn = async (file: string) => {
      const restored = new PGlite({ loadDataDir: new Blob([await readFile(file)]) })
      const { rows } = await restored.query('select email from users order by email')
      await restored.close()
      return rows
    }
    expect(await emailsIn(dumpPath)).toEqual([{ email: 'alice@example.com' }])
    // It holds the whole database, so only the issuer's user reads it.
    expect((await stat(dumpPath)).mode & 0o777).toBe(0o600)

    // A dump that cannot be written stops the step, and the last dump stays whole.
    const db2 = openDb(dataDir)
    await db2.insert(users).values({ id: 'u2', name: 'Bob', email: 'bob@example.com' })
    await db2.$client.close()
    await mkdir(`${dumpPath}.tmp`)
    await expect(migrateDataDir(dataDir, dumpPath)).rejects.toThrow()
    expect(await emailsIn(dumpPath)).toEqual([{ email: 'alice@example.com' }])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
