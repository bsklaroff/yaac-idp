/**
 * The issuer's one process: a public and an admin listener over one
 * database. Only one process may open a PGlite directory, which is why the
 * admin routes are a listener here and not a second service.
 */
import path from 'node:path'
import { serve } from '@hono/node-server'
import { adminApp } from './admin-app.ts'
import { createAuth } from './auth.ts'
import { readConfig } from './config.ts'
import { openDb } from './db/index.ts'
import { consoleMailer, resendMailer } from './mailer.ts'
import { publicApp } from './public-app.ts'

const config = readConfig()
const webRoot = path.resolve(import.meta.dirname, '../../dist/web')
const db = openDb(config.dataDir)
const mailer = config.mail ? resendMailer(config.mail, config.name) : consoleMailer()
if (!config.mail) console.warn('IDP_PRINT_CODES is set: sign-in codes are printed here, not mailed')
const auth = createAuth(config, db, mailer)

const servers = [
  serve({ fetch: publicApp(auth, config.publicUrl, webRoot).fetch, port: config.port }),
  // yaac's forward dials the admin port at localhost inside the pod, so
  // nothing outside the pod needs to reach it.
  serve({ fetch: adminApp(auth, db, config, webRoot).fetch, port: config.adminPort, hostname: '127.0.0.1' }),
]
console.log(`${config.publicUrl} on :${config.port}, admin on :${config.adminPort}`)

/** Closes the database cleanly, so the next release finds no recovery to do. */
async function stop(): Promise<void> {
  await Promise.all(servers.map((server) => new Promise((done) => {
    server.close(done)
    if ('closeAllConnections' in server) server.closeAllConnections()
  })))
  await db.$client.close()
  process.exit(0)
}
process.once('SIGTERM', () => void stop())
process.once('SIGINT', () => void stop())
