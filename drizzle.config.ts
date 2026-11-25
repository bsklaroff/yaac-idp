import { defineConfig } from 'drizzle-kit'

/** For `pnpm db:generate`, which diffs the schema against ./drizzle. */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/server/db/schema.ts',
  out: './drizzle',
})
