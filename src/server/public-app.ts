/**
 * The public listener: the OIDC endpoints, the routes the sign-in page calls,
 * and the page itself. better-auth registers many more routes than an issuer
 * needs (account management, client registration), so only the ones named
 * here are served.
 */
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { serveStatic } from '@hono/node-server/serve-static'
import { oauthProviderAuthServerMetadata, oauthProviderOpenIdConfigMetadata } from '@better-auth/oauth-provider'
import { addressNamedBy, AUTH_BASE_PATH, CONSENT_PAGE, SIGN_IN_PAGE, type Auth } from './auth.ts'
import { securityHeaders } from './headers.ts'
import { requestLog, type AuditEnv } from './log.ts'

const AUTH_ROUTES = new Set([
  'GET /oauth2/authorize',
  'POST /oauth2/token',
  'GET /oauth2/userinfo',
  'POST /oauth2/userinfo',
  'POST /oauth2/revoke',
  'POST /oauth2/introspect',
  'GET /oauth2/end-session',
  'POST /oauth2/end-session',
  // The form the issuer shows when an app's logout names no session or
  // another one: it ends only this browser's own session, and only with the
  // signed confirmation cookie that page set.
  'POST /oauth2/end-session/confirm',
  'GET /jwks',
  'POST /email-otp/send-verification-otp',
  'POST /sign-in/email-otp',
  'GET /get-session',
  'POST /sign-out',
])

const SEND_CODE = 'POST /email-otp/send-verification-otp'
const SIGN_IN = 'POST /sign-in/email-otp'
const TOKEN = 'POST /oauth2/token'

/**
 * The routes only the sign-in page calls. A browser marks a call from any
 * other page, a sibling site's included, in `Origin` or `Sec-Fetch-Site`,
 * neither of which page script can forge; a client that sends neither is no
 * browser, and has no visitor's cookies to misuse.
 */
const PAGE_ROUTES = new Set([SEND_CODE, SIGN_IN, 'POST /sign-out', 'POST /oauth2/end-session/confirm'])

/**
 * better-auth tells a wrong code from a used-up or expired one, but only an
 * address that may sign in has a code to use up or let expire, so the
 * difference would say which addresses may. Every refused code gets this.
 */
const WRONG_CODE = { code: 'INVALID_OTP', message: 'That code is wrong or no longer works.' }

/** The app's request the sign-in page carries is good for ten minutes. */
const EXPIRED_PAGE = { code: 'EXPIRED_SIGN_IN', message: 'This sign-in page has expired. Go back to the app and sign in again.' }

/**
 * Apps are registered for `client_secret_post` alone, with no back-channel
 * logout or DPoP, so discovery offers no more: a client library takes the
 * first method it is offered and fails on any other.
 */
const APP_ONLY_METADATA = {
  token_endpoint_auth_methods_supported: ['client_secret_post'],
  introspection_endpoint_auth_methods_supported: ['client_secret_post'],
  revocation_endpoint_auth_methods_supported: ['client_secret_post'],
}
const UNUSED_METADATA = [
  'token_endpoint_auth_signing_alg_values_supported',
  'introspection_endpoint_auth_signing_alg_values_supported',
  'revocation_endpoint_auth_signing_alg_values_supported',
  'backchannel_logout_supported',
  'backchannel_logout_session_supported',
  'dpop_signing_alg_values_supported',
]

async function appMetadata(res: Response): Promise<Response> {
  const doc = await res.json() as Record<string, unknown>
  for (const key of UNUSED_METADATA) delete doc[key]
  return Response.json({ ...doc, ...APP_ONLY_METADATA }, { status: res.status, headers: { 'cache-control': res.headers.get('cache-control') ?? 'no-store' } })
}

/**
 * Who an issued ID token names and for which app, for the log: each one is
 * a person signed in to an app. The issuer signed it, so it needs no check.
 */
async function tokenAudit(res: Response): Promise<Record<string, string | undefined>> {
  try {
    const { id_token: idToken } = await res.clone().json() as { id_token?: string }
    const claims = JSON.parse(Buffer.from(idToken?.split('.')[1] ?? '', 'base64url').toString()) as Record<string, unknown>
    return { userId: String(claims.sub), clientId: String(claims.aud), email: String(claims.email) }
  } catch {
    return {}
  }
}

/**
 * The logout confirmation cookie is named after the session cookie, so it
 * is `__Host-` too, but the plugin scopes it to the confirmation route. A
 * browser drops a `__Host-` cookie whose path is not `/`, so it is given `/`.
 */
function rootHostCookies(res: Response): Response {
  const cookies = res.headers.getSetCookie()
  if (!cookies.some((cookie) => /^__Host-.*; Path=\/[^;]/i.test(cookie))) return res
  const fixed = new Response(res.body, res)
  fixed.headers.delete('set-cookie')
  for (const cookie of cookies) fixed.headers.append('set-cookie', cookie.startsWith('__Host-') ? cookie.replace(/; Path=[^;]*/i, '; Path=/') : cookie)
  return fixed
}

function fromOwnPage(publicUrl: string, origin: string | undefined, site: string | undefined): boolean {
  return (origin === undefined || origin === publicUrl) && (site === undefined || site === 'same-origin')
}

export function publicApp(auth: Auth, publicUrl: string, webRoot: string) {
  const app = new Hono<AuditEnv>()
  app.use(requestLog('public'), securityHeaders)
  app.get('/health', (c) => c.text('ok'))

  const openIdConfig = oauthProviderOpenIdConfigMetadata(auth)
  const authServerConfig = oauthProviderAuthServerMetadata(auth)
  app.get('/.well-known/openid-configuration', async (c) => appMetadata(await openIdConfig(c.req.raw)))
  app.get('/.well-known/oauth-authorization-server', async (c) => appMetadata(await authServerConfig(c.req.raw)))

  /*
   * Anyone may send these routes a body, so it is cut off past this many
   * bytes before anything reads it, a chunked one included. The largest
   * honest body is a sign-in's `oauth_query`, an app's authorization request
   * of a few hundred bytes.
   */
  app.use(`${AUTH_BASE_PATH}/*`, bodyLimit({
    maxSize: 32 * 1024,
    onError: (c) => c.json({ message: 'request body too large' }, 413),
  }))

  app.all(`${AUTH_BASE_PATH}/*`, async (c) => {
    // The path as sent, as better-auth's router reads it: Hono's own decodes it.
    const route = `${c.req.method} ${new URL(c.req.url).pathname.slice(AUTH_BASE_PATH.length)}`
    if (!AUTH_ROUTES.has(route)) return c.notFound()
    if (PAGE_ROUTES.has(route) && !fromOwnPage(publicUrl, c.req.header('origin'), c.req.header('sec-fetch-site'))) {
      return c.json({ message: 'cross-site request' }, 403)
    }
    const res = rootHostCookies(await auth.handler(c.req.raw))
    if (route === SEND_CODE || route === SIGN_IN) c.set('audit', { email: addressNamedBy(c.req.raw) })
    if (route === TOKEN && res.ok) c.set('audit', await tokenAudit(res))
    if (route !== SIGN_IN || (res.status !== 400 && res.status !== 403)) return res
    const { error } = await res.clone().json().catch(() => ({})) as { error?: string }
    return c.json(error === 'invalid_signature' ? EXPIRED_PAGE : WRONG_CODE, 400)
  })

  app.use('/assets/*', serveStatic({ root: webRoot }))
  const page = serveStatic({ root: webRoot, path: 'index.html' })
  for (const path of ['/', SIGN_IN_PAGE, CONSENT_PAGE]) app.get(path, page)
  return app
}
