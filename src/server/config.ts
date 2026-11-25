/**
 * The issuer's settings, read once from the environment. No other module
 * reads `process.env`.
 */
import path from 'node:path'

export interface Config {
  /** The issuer's URL: its public origin, with no path. */
  publicUrl: string
  /** Signs cookies and the sign-in page's query, and encrypts the signing keys. */
  secret: string
  /** The PGlite data directory. */
  dataDir: string
  /** Where the migrate step writes its dump of the database. */
  dumpPath: string
  port: number
  adminPort: number
  /** Whether a first sign-in creates the user. Closed when false. */
  openSignUp: boolean
  /** The name sign-in mail and pages show. */
  name: string
  /** Null only when codes are printed to the log instead, for development. */
  mail: { apiKey: string, from: string } | null
}

type Env = Record<string, string | undefined>

function required(env: Env, name: string): string {
  const value = env[name]
  if (!value) throw new Error(`${name} is not set`)
  return value
}

function port(env: Env, name: string, fallback: number): number {
  const value = Number(env[name] ?? fallback)
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`${name} is not a port`)
  return value
}

export function readConfig(env: Env = process.env): Config {
  const publicUrl = new URL(required(env, 'IDP_PUBLIC_URL'))
  if (publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash) {
    throw new Error('IDP_PUBLIC_URL must be an origin, with no path')
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(publicUrl.hostname)
  // Over plain http the session cookie could be read and replayed on the way.
  if (publicUrl.protocol !== 'https:' && !loopback) throw new Error('IDP_PUBLIC_URL must be https, except on localhost')
  // Whoever reads the log of an issuer that prints codes can sign in as anyone.
  if (env.IDP_PRINT_CODES === 'true' && !loopback) throw new Error('IDP_PRINT_CODES is for an issuer on localhost alone')
  const secret = required(env, 'BETTER_AUTH_SECRET')
  if (secret.length < 32) throw new Error('BETTER_AUTH_SECRET must be at least 32 characters')
  const root = env.IDP_DATA_DIR ?? env.YAAC_VOLUME_DIR ?? 'data'
  const config: Config = {
    publicUrl: publicUrl.origin,
    secret,
    dataDir: path.resolve(root, 'pg'),
    dumpPath: path.resolve(root, 'pre-migrate.tar.gz'),
    port: port(env, 'IDP_PORT', 3000),
    adminPort: port(env, 'IDP_ADMIN_PORT', 3001),
    openSignUp: env.IDP_OPEN_SIGNUP === 'true',
    name: env.IDP_NAME ?? publicUrl.hostname,
    // A release's log is read by more people than its inbox, so printing
    // codes there is never a fallback: it is asked for by name.
    mail: env.IDP_PRINT_CODES === 'true'
      ? null
      : { apiKey: required(env, 'RESEND_API_KEY'), from: required(env, 'IDP_MAIL_FROM') },
  }
  if (config.port === config.adminPort) throw new Error('IDP_PORT and IDP_ADMIN_PORT must differ')
  return config
}
