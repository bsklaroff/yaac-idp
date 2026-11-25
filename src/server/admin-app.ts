/**
 * The admin listener: registering apps and adding and removing users. These
 * routes check no identity. They are served on the admin port alone, which
 * only the site's owner reaches, through a forward the yaac server
 * authorizes, and only to what a browser could have sent from this
 * listener's own page (`ownerOnly`).
 *
 * The routes are chained so that `AdminApp` carries their types, which is
 * what the admin page's client is typed from.
 */
import { randomUUID } from 'node:crypto'
import { serveStatic } from '@hono/node-server/serve-static'
import { zValidator } from '@hono/zod-validator'
import { desc, eq } from 'drizzle-orm'
import { Hono, type MiddlewareHandler } from 'hono'
import { z, type ZodType } from 'zod'
import { APIError } from 'better-auth/api'
import { signInCodeId, type Auth, type AuthSettings } from './auth.ts'
import type { Db } from './db/index.ts'
import { oauthClients, sessions, users, verifications } from './db/schema.ts'
import { securityHeaders } from './headers.ts'
import { requestLog, type AuditEnv } from './log.ts'

const newApp = z.object({
  name: z.string().trim().min(1).max(100),
  // The provider decides between http and https itself (`/api/apps`).
  redirectUris: z.array(z.url({ protocol: /^https?$/ }).refine((uri) => {
    const url = URL.parse(uri)
    return !url || (!uri.includes('#') && !url.username && !url.password)
  }, 'a redirect URI takes no fragment or credentials')).min(1).max(20),
})

const newUser = z.object({
  email: z.email().max(254).transform((email) => email.toLowerCase()),
  name: z.string().trim().max(100).default(''),
})

/** Validates a JSON body, answering 400 with what is wrong with it. */
function body<T extends ZodType>(schema: T) {
  return zValidator('json', schema, (result, c) => {
    if (!result.success) return c.json({ error: z.prettifyError(result.error) }, 400)
  })
}

/** The names the owner's forward is reached at: loopback, and yaac's `*.localhost` names. */
function isLoopbackHost(host: string): boolean {
  const { hostname } = new URL(`http://${host}`)
  return ['localhost', '127.0.0.1', '[::1]'].includes(hostname) || hostname.endsWith('.localhost')
}

/**
 * Whether a browser could have sent the request from this listener's own
 * page. A missing header is a client that is not a browser. A cross-site
 * navigation to the page itself is let through, so other pages (yaac's own
 * among them) can link to it.
 */
function fromOwnPage(host: string, origin: string | undefined, site: string | undefined, navigation: boolean): boolean {
  if (origin !== undefined && new URL(origin).origin !== new URL(`http://${host}`).origin) return false
  return site === undefined || site === 'same-origin' || site === 'none' || navigation
}

/**
 * The forward puts this port on the owner's own machine, where any page
 * their browser has open can send it a request.
 *
 * - A page that points its own hostname at 127.0.0.1 (DNS rebinding) is
 *   same-origin with this port in the browser's eyes, but its requests
 *   still name that hostname in Host, so only a loopback Host is served.
 * - Any other page's request is marked cross-origin in `Origin` or
 *   `Sec-Fetch-Site`, and refused.
 * - A preflight is refused, so a browser never sends a cross-origin
 *   request that needs one.
 */
const ownerOnly: MiddlewareHandler = async (c, next) => {
  // In-process requests (tests) have no Host header, only a URL.
  const host = c.req.header('host') ?? new URL(c.req.url).host
  const navigation = c.req.method === 'GET' && c.req.header('sec-fetch-mode') === 'navigate'
    && c.req.header('sec-fetch-dest') === 'document'
  let allowed = false
  try {
    allowed = c.req.method !== 'OPTIONS' && isLoopbackHost(host)
      && fromOwnPage(host, c.req.header('origin'), c.req.header('sec-fetch-site'), navigation)
  } catch {
    // An unparsable Host or Origin (`Origin: null`) is refused.
  }
  if (!allowed) return c.json({ error: 'not allowed from here' }, 403)
  await next()
}

export function adminApp(auth: Auth, db: Db, settings: AuthSettings, webRoot: string) {
  return new Hono<AuditEnv>()
    .use(requestLog('admin'), ownerOnly, securityHeaders)

    .get('/api/settings', (c) => c.json({ issuer: settings.publicUrl, openSignUp: settings.openSignUp }))

    .get('/api/apps', async (c) => {
      const rows = await db.select().from(oauthClients).orderBy(desc(oauthClients.createdAt))
      return c.json(rows.map((row) => ({
        clientId: row.clientId,
        name: row.name ?? '',
        redirectUris: row.redirectUris,
      })))
    })

    /*
     * An app is the install's own, so it skips the consent page. It sends
     * its secret in the token request's form body, the field a yaac project
     * secret's rule names, and the answer here is the only time it is shown.
     *
     * Its sign-out may end the issuer session too (RP-initiated logout), or
     * signing in to any app would carry on silently, and the browser is sent
     * back to the root of the app's origin.
     */
    .post('/api/apps', body(newApp), async (c) => {
      const { name, redirectUris } = c.req.valid('json')
      const client = await auth.api.adminCreateOAuthClient({
        headers: new Headers(),
        body: {
          client_name: name,
          redirect_uris: redirectUris,
          token_endpoint_auth_method: 'client_secret_post',
          skip_consent: true,
          enable_end_session: true,
          post_logout_redirect_uris: [...new Set(redirectUris.map((uri) => `${new URL(uri).origin}/`))],
        },
      }).catch((error: unknown) => {
        // The provider's own refusal, such as a redirect URI that is not https.
        if (error instanceof APIError) return { refused: String(error.body?.error_description ?? error.message) }
        throw error
      })
      if ('refused' in client) return c.json({ error: client.refused }, 400)
      c.set('audit', { clientId: client.client_id, name, redirectUris: redirectUris.join(' ') })
      return c.json({ clientId: client.client_id, clientSecret: client.client_secret ?? '', name, redirectUris }, 201)
    })

    .delete('/api/apps/:clientId', async (c) => {
      const gone = await db.delete(oauthClients).where(eq(oauthClients.clientId, c.req.param('clientId'))).returning()
      c.set('audit', { clientId: gone[0]?.clientId, name: gone[0]?.name ?? undefined })
      return gone.length ? c.body(null, 204) : c.json({ error: 'no such app' }, 404)
    })

    .get('/api/users', async (c) => {
      const rows = await db.select().from(users).orderBy(users.email)
      return c.json(rows.map(({ id, email, name }) => ({ id, email, name })))
    })

    /*
     * Adding a user is the owner's word that the address is theirs, so it is
     * marked verified. Their id is the `sub` every app sees. Adding and
     * removing a user withdraws any code out for the address, so a code
     * issued to one account cannot sign in another at the same address.
     */
    .post('/api/users', body(newUser), async (c) => {
      const row = await db.transaction(async (tx) => {
        const [added] = await tx.insert(users)
          .values({ id: randomUUID(), ...c.req.valid('json'), emailVerified: true })
          .onConflictDoNothing()
          .returning()
        if (added) await tx.delete(verifications).where(eq(verifications.identifier, signInCodeId(added.email)))
        return added
      })
      if (!row) return c.json({ error: 'a user with that email exists' }, 409)
      c.set('audit', { userId: row.id, email: row.email })
      return c.json({ id: row.id, email: row.email, name: row.name }, 201)
    })

    /**
     * Ends every issuer session the user has, keeping their account and
     * `sub`: a lost device, say. Each app keeps its own session until it ends.
     */
    .post('/api/users/:id/sign-out', async (c) => {
      const [user] = await db.select().from(users).where(eq(users.id, c.req.param('id')))
      if (!user) return c.json({ error: 'no such user' }, 404)
      await db.delete(sessions).where(eq(sessions.userId, user.id))
      c.set('audit', { userId: user.id, email: user.email })
      return c.body(null, 204)
    })

    /** Removes the user with their sessions and every token issued for them. */
    .delete('/api/users/:id', async (c) => {
      const gone = await db.transaction(async (tx) => {
        const [removed] = await tx.delete(users).where(eq(users.id, c.req.param('id'))).returning()
        if (removed) await tx.delete(verifications).where(eq(verifications.identifier, signInCodeId(removed.email)))
        return removed
      })
      if (!gone) return c.json({ error: 'no such user' }, 404)
      c.set('audit', { userId: gone.id, email: gone.email })
      return c.body(null, 204)
    })

    /*
     * The workflow's readiness check: a release is ready once its database
     * answers, not merely once it listens. It is on this listener, which
     * the internet never reaches, so no outside request queries the
     * database through it.
     */
    .get('/ready', async (c) => {
      let timer: NodeJS.Timeout | undefined
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('the database did not answer')), 2000)
      })
      try {
        await Promise.race([db.select({ id: users.id }).from(users).limit(1), timeout])
        return c.text('ready')
      } catch {
        return c.text('not ready', 503)
      } finally {
        clearTimeout(timer)
      }
    })

    .use('/assets/*', serveStatic({ root: webRoot }))
    .get('/', serveStatic({ root: webRoot, path: 'admin.html' }))
}

export type AdminApp = ReturnType<typeof adminApp>
