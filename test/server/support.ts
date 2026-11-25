/**
 * An issuer over an in-memory database, with a mailer that keeps the codes
 * it was asked to send and a browser's worth of cookie handling.
 */
import path from 'node:path'
import { vi } from 'vitest'
import { adminApp } from '#server/admin-app.ts'
import { createAuth, type AuthSettings } from '#server/auth.ts'
import { applyMigrations, openDb } from '#server/db/index.ts'
import { publicApp } from '#server/public-app.ts'

export const ISSUER = 'https://auth.example.com'

/** The request log's lines, kept off the test output. */
const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined)
export function logged(): Record<string, unknown>[] {
  return consoleLog.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
}
const WEB_ROOT = path.resolve(import.meta.dirname, 'web-root')

/**
 * `deliver` is what mailing a code does once it is recorded: by default it
 * works, and a test passes one that fails or never ends.
 */
export async function startIssuer(overrides: Partial<AuthSettings> = {}, deliver = () => Promise.resolve()) {
  const settings = { publicUrl: ISSUER, secret: 'test-secret-'.repeat(4), openSignUp: false, ...overrides }
  const db = openDb()
  await applyMigrations(db)
  const mail: { email: string, code: string }[] = []
  const auth = createAuth(settings, db, {
    sendCode: (email, code) => {
      mail.push({ email, code })
      return deliver()
    },
  })
  return {
    auth,
    db,
    mail,
    pub: publicApp(auth, settings.publicUrl, WEB_ROOT),
    admin: adminApp(auth, db, settings, WEB_ROOT),
    close: () => db.$client.close(),
  }
}

export type Issuer = Awaited<ReturnType<typeof startIssuer>>

/**
 * A browser at the issuer: keeps cookies, sends the page's Origin. Requests
 * arrive as they do behind yaac's edge, which ends TLS: plain HTTP for the
 * site's Host, with the scheme in X-Forwarded-Proto.
 *
 * It refuses any cookie a browser would not take as `__Host-`, which no
 * sibling site can set (README "The issuer session").
 */
export function browser(issuer: Issuer, ip = '203.0.113.7') {
  const cookies = new Map<string, string>()
  async function request(
    pathAndQuery: string,
    init: { method?: string, json?: unknown, form?: Record<string, string>, headers?: Record<string, string> } = {},
  ): Promise<Response> {
    const headers = new Headers({ 'x-forwarded-for': ip, 'x-forwarded-proto': 'https', 'origin': ISSUER, ...init.headers })
    if (cookies.size) headers.set('cookie', [...cookies].map(([k, v]) => `${k}=${v}`).join('; '))
    if (init.json !== undefined) headers.set('content-type', 'application/json')
    if (init.form !== undefined) headers.set('content-type', 'application/x-www-form-urlencoded')
    const body = init.json !== undefined ? JSON.stringify(init.json) : init.form && new URLSearchParams(init.form)
    const res = await issuer.pub.request(new URL(pathAndQuery, ISSUER.replace('https:', 'http:')), {
      method: init.method ?? (body === undefined ? 'GET' : 'POST'),
      headers,
      body,
    })
    for (const cookie of res.headers.getSetCookie()) {
      if (!/^__Host-[^;]*(?=.*; Secure)(?=.*; Path=\/(;|$))(?!.*Domain=)/i.test(cookie)) throw new Error(`not a __Host- cookie: ${cookie}`)
      const [pair = ''] = cookie.split(';')
      const eq = pair.indexOf('=')
      if (/max-age=0/i.test(cookie)) cookies.delete(pair.slice(0, eq))
      else cookies.set(pair.slice(0, eq), pair.slice(eq + 1))
    }
    return res
  }
  return { request, cookies }
}

export async function adminJson<T>(issuer: Issuer, method: string, route: string, body?: unknown): Promise<T> {
  const res = await issuer.admin.request(route, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${method} ${route}: ${res.status} ${await res.text()}`)
  return (res.status === 204 ? undefined : await res.json()) as T
}

export const REDIRECT_URI = 'https://app.example.com/callback'

export interface RegisteredApp { clientId: string, clientSecret: string }

export function registerApp(issuer: Issuer): Promise<RegisteredApp> {
  return adminJson(issuer, 'POST', '/api/apps', { name: 'Notes', redirectUris: [REDIRECT_URI] })
}

/** Asks for a code and returns the one mailed, or undefined when none was. */
export async function requestCode(issuer: Issuer, b: ReturnType<typeof browser>, email: string) {
  const before = issuer.mail.length
  const res = await b.request('/api/auth/email-otp/send-verification-otp', { json: { email, type: 'sign-in' } })
  return { res, code: issuer.mail[before]?.code }
}
