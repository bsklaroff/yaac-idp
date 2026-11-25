/**
 * The issuer: better-auth signing people in by a code sent to their email,
 * and its OAuth provider plugin serving OpenID Connect to the registered
 * apps. `baseURL` is fixed to the public URL, so no request header changes
 * what the issuer calls itself.
 */
import { betterAuth, type BetterAuthPlugin } from 'better-auth'
import { APIError, createAuthMiddleware } from 'better-auth/api'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { emailOTP, jwt } from 'better-auth/plugins'
import { oauthProvider } from '@better-auth/oauth-provider'
import { createHmac } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { codeBudget } from './code-budget.ts'
import type { Config } from './config.ts'
import type { Db } from './db/index.ts'
import * as schema from './db/schema.ts'
import type { Mailer } from './mailer.ts'

/** Where better-auth's routes are mounted on the public listener. */
export const AUTH_BASE_PATH = '/api/auth'
export const SIGN_IN_PAGE = '/sign-in'
export const CONSENT_PAGE = '/consent'

/** The plugin's route that registers an app. It is server-only: no request reaches it. */
const CREATE_CLIENT_PATH = '/admin/oauth2/create-client'
const ADMIN_SESSION_ID = 'admin-listener'
const SEND_CODE_PATH = '/email-otp/send-verification-otp'
const SIGN_IN_PATH = '/sign-in/email-otp'

/** How many codes one address is sent an hour, however many clients ask. */
export const CODES_PER_ADDRESS = 5
const CODE_WINDOW_MS = 60 * 60_000
/** Slots the per-address limit keeps, about 2.6 MB: see `codeBudget`. */
const CODE_BUCKETS = 65_536

/**
 * The provider plugin registers a client only for a signed-in user that
 * `clientPrivileges` admits. The admin listener has no users of its own (the
 * yaac server's owner check on the forward is its access control), so this
 * plugin gives the server's own call a session that names no user, and
 * `clientPrivileges` admits that session alone.
 */
const adminCaller: BetterAuthPlugin = {
  id: 'admin-caller',
  hooks: {
    before: [{
      matcher: (ctx) => ctx.path === CREATE_CLIENT_PATH,
      handler: createAuthMiddleware((ctx) => {
        ctx.context.session = { session: { id: ADMIN_SESSION_ID }, user: {} } as typeof ctx.context.session
        return Promise.resolve()
      }),
    }],
  },
}

/** better-auth's name for the row holding an address's sign-in code. */
export function signInCodeId(email: string): string {
  return `sign-in-otp-${email.toLowerCase()}`
}

/**
 * The address a code request or code sign-in named, for the request log.
 * It is read from better-auth's own parse of the body, after its limits,
 * so the log adds no work an unlimited client could make the issuer do.
 */
const namedAddress = new WeakMap<Request, string>()
export function addressNamedBy(request: Request): string | undefined {
  return namedAddress.get(request)
}

/**
 * better-auth limits how many codes one client asks for, but not how many
 * one address is sent. Each code takes three guesses, so without this an
 * attacker with many client addresses could guess a person's code. The limit
 * holds for every address, known or not, so it says nothing of who may sign
 * in. It lives in memory, as better-auth's own limits do.
 *
 * Only sign-in codes are sent. The route makes others (password resets,
 * email changes) for routes this issuer does not serve, so it refuses them
 * rather than let them count against a person's limit.
 */
function addressLimit(): BetterAuthPlugin {
  const budget = codeBudget({ perAddress: CODES_PER_ADDRESS, windowMs: CODE_WINDOW_MS, buckets: CODE_BUCKETS })
  return {
    id: 'address-limit',
    hooks: {
      before: [{
        matcher: (ctx) => ctx.path === SEND_CODE_PATH || ctx.path === SIGN_IN_PATH,
        handler: createAuthMiddleware((ctx) => {
          const body = ctx.body as { email?: unknown, type?: unknown } | undefined
          const address = String(body?.email).toLowerCase()
          if (ctx.request && typeof body?.email === 'string') namedAddress.set(ctx.request, address)
          if (ctx.path !== SEND_CODE_PATH) return Promise.resolve()
          if (body?.type !== 'sign-in') throw new APIError('BAD_REQUEST', { message: 'Only sign-in codes are sent.' })
          if (!budget.take(address)) {
            throw new APIError('TOO_MANY_REQUESTS', { message: 'Too many codes were sent to this address. Try again in an hour.' })
          }
          return Promise.resolve()
        }),
      }],
    },
  }
}

export type AuthSettings = Pick<Config, 'publicUrl' | 'secret' | 'openSignUp'>

function isLoopback(url: string): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)
}

/**
 * How the endpoints an app calls with its secret are limited, per client
 * address. Apps on one yaac cluster reach the issuer from one egress
 * address, so better-auth's defaults (20 token requests a minute) would let
 * one busy app shut the others out. Guessing a client secret or an
 * authorization code is hopeless at any rate, so these only bound a flood.
 */
const APP_ROUTE_LIMIT = { window: 60, max: 600 }

export function createAuth(settings: AuthSettings, db: Db, mailer: Mailer) {
  /*
   * A six-digit code has a million values, so a plain hash of one is undone
   * by hashing them all. Codes are stored keyed instead, with a key of their
   * own derived from the secret, so reading the database tells no one a
   * code.
   */
  const codeKey = createHmac('sha256', settings.secret).update('sign-in codes').digest()
  const hashCode = (code: string) => createHmac('sha256', codeKey).update(code).digest('base64url')
  return betterAuth({
    baseURL: settings.publicUrl,
    basePath: AUTH_BASE_PATH,
    secret: settings.secret,
    database: drizzleAdapter(db, { provider: 'pg', schema, usePlural: true }),
    // On in every environment: anyone can ask the issuer to mail a code.
    rateLimit: { enabled: true },
    // The oauth provider serves its own token-authenticated routes.
    disabledPaths: ['/token'],
    /*
     * Over https the cookies are `__Host-`: a browser takes such a cookie
     * only from this host, with no Domain. Without it, a site on a sibling
     * hostname could set its own session cookie for the parent domain and
     * sign a visitor in here as someone else. better-auth names cookies
     * `__Secure-` by itself, so that is turned off and Secure set by hand.
     */
    advanced: {
      ...(settings.publicUrl.startsWith('https:')
        && { useSecureCookies: false, cookiePrefix: '__Host-better-auth', defaultCookieAttributes: { secure: true } }),
      // better-auth skips its origin check under a test runner; this keeps
      // the tests running what production runs.
      disableOriginCheck: false,
    },
    // A request the provider cannot send back to its app (an unknown client
    // or redirect URI) lands on the sign-in page, which says the link is bad.
    onAPIError: { errorURL: `${settings.publicUrl}${SIGN_IN_PAGE}` },
    // A person's name comes from the admin page alone; a sign-up request
    // that names one is ignored.
    databaseHooks: {
      user: { create: { before: (user) => Promise.resolve({ data: { ...user, name: '', image: null } }) } },
    },
    plugins: [
      emailOTP({
        otpLength: 6,
        expiresIn: 300,
        allowedAttempts: 3,
        disableSignUp: !settings.openSignUp,
        storeOTP: { hash: (code) => Promise.resolve(hashCode(code)) },
        /*
         * The answer does not wait for the mail, so it takes as long for an
         * address that may sign in as for one that may not. A code whose mail
         * failed is deleted, so no one can go on guessing a code its owner
         * never got. Only that code is: the row is `<hash>:<wrong guesses>`,
         * and a newer code mailed since has another hash.
         */
        sendVerificationOTP({ email, otp }) {
          const hash = hashCode(otp)
          const { verifications } = schema
          mailer.sendCode(email, otp).catch(async (error: unknown) => {
            await db.delete(verifications).where(and(
              eq(verifications.identifier, signInCodeId(email)),
              eq(sql`split_part(${verifications.value}, ':', 1)`, hash),
            ))
            console.error(`mailing a sign-in code failed, so the code was withdrawn: ${String(error)}`)
          }).catch((error: unknown) => console.error(`withdrawing an unmailed code failed: ${String(error)}`))
          return Promise.resolve()
        },
      }),
      // RS256 is the one algorithm every OpenID Connect client must accept.
      jwt({
        jwt: { issuer: settings.publicUrl },
        jwks: { keyPairConfig: { alg: 'RS256' } },
        // The adapter adds the plural's "s", which makes this the `jwks` table.
        schema: { jwks: { modelName: 'jwk' } },
        // ID tokens are the issuer's only signed tokens; the sign-in page's
        // session answer carries none.
        disableSettingJwtHeader: true,
      }),
      oauthProvider({
        loginPage: SIGN_IN_PAGE,
        consentPage: CONSENT_PAGE,
        /*
         * No refresh tokens: an app reads who signed in from the ID token
         * and keeps its own session, and signs the person in again by
         * redirect when that ends.
         */
        scopes: ['openid', 'profile', 'email'],
        grantTypes: ['authorization_code'],
        // Apps read who signed in from the ID token, without a second
        // request to the userinfo endpoint.
        customIdTokenClaims: ({ user, scopes }) => ({
          ...(scopes.includes('email') && { email: user.email, email_verified: user.emailVerified }),
          ...(scopes.includes('profile') && { name: user.name }),
        }),
        // Apps are registered on the admin listener alone. A person's
        // session grants nothing.
        clientPrivileges: ({ session }) => session?.id === ADMIN_SESSION_ID,
        resourcePrivileges: () => false,
        rateLimit: { token: APP_ROUTE_LIMIT, userinfo: APP_ROUTE_LIMIT, revoke: APP_ROUTE_LIMIT, introspect: APP_ROUTE_LIMIT },
        // An issuer run on this machine takes an app run here too.
        ...(isLoopback(settings.publicUrl) && { allowInsecureRedirectUri: (url: URL) => isLoopback(url.href) }),
      }),
      adminCaller,
      addressLimit(),
    ],
  })
}

export type Auth = ReturnType<typeof createAuth>
