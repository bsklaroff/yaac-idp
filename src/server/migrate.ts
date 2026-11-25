/**
 * The workflow's migrate step. It runs after the volume handoff, when no
 * older release has the database open, and ends before the server starts.
 */
import { readConfig } from './config.ts'
import { migrateDataDir } from './db/index.ts'

const { dataDir, dumpPath } = readConfig()
await migrateDataDir(dataDir, dumpPath)
