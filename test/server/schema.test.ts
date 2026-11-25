import { getTableColumns, getTableName, type Table } from 'drizzle-orm'
import { getAuthTables } from 'better-auth/db'
import { expect, test } from 'vitest'
import * as schema from '#server/db/schema.ts'
import { startIssuer } from './support.ts'

/*
 * The schema is written by hand, in this repo's style, for models better-auth
 * defines. After a better-auth upgrade or a plugin change this says which
 * tables and columns to add or drop.
 */
test('the schema has exactly the tables and columns better-auth uses', async () => {
  const issuer = await startIssuer()
  const wanted = Object.fromEntries(Object.values(getAuthTables(issuer.auth.options)).map((model) => [
    `${model.modelName}s`,
    ['id', ...Object.entries(model.fields).map(([key, field]) => field.fieldName ?? key)].sort(),
  ]))
  const tables: Record<string, Table> = schema
  const actual = Object.fromEntries(Object.entries(tables).map(([key, table]) => {
    expect(getTableName(table), key).toBe(key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`))
    return [key, Object.keys(getTableColumns(table)).sort()]
  }))
  expect(actual).toEqual(wanted)
  await issuer.close()
})
