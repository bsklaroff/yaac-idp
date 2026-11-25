/**
 * The request log: one JSON line on stdout per request, the record of who
 * signed in where and what the admin page changed. A route adds what it is
 * worth auditing (an email, a user, an app) to `audit`.
 *
 * It holds no query string, body, cookie, code, token or secret, so an
 * authorization request's state and a token request's client secret stay
 * out. Under yaac a release's log is read by the project's agents as
 * untrusted text, so every value is JSON-escaped (no request can write a
 * line of its own) and clipped.
 */
import type { MiddlewareHandler } from 'hono'

export interface AuditEnv {
  Variables: { audit?: Record<string, string | undefined> }
}

const clip = (value: string | undefined) => value?.slice(0, 256)

export function requestLog(listener: 'public' | 'admin'): MiddlewareHandler<AuditEnv> {
  return async (c, next) => {
    const start = performance.now()
    await next()
    if (c.req.path === '/health' || c.req.path === '/ready') return
    const audit = Object.fromEntries(Object.entries(c.get('audit') ?? {}).map(([key, value]) => [key, clip(value)]))
    console.log(JSON.stringify({
      time: new Date().toISOString(),
      listener,
      method: c.req.method,
      path: clip(c.req.path),
      status: c.res.status,
      ms: Math.round(performance.now() - start),
      ip: clip(c.req.header('x-forwarded-for')),
      ...audit,
    }))
  }
}
