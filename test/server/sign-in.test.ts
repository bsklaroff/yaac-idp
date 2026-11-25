import { createHash, randomBytes } from 'node:crypto'
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose'
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { CODES_PER_ADDRESS } from '#server/auth.ts'
import { verifications } from '#server/db/schema.ts'
import {
  adminJson, browser, ISSUER, logged, REDIRECT_URI, registerApp, requestCode, startIssuer, type Issuer, type RegisteredApp,
} from './support.ts'

const AUTH = `${ISSUER}/api/auth`

const OTHER_REDIRECT_URI = 'https://tasks.example.com/callback'

/** An authorization request as an app would send it, and what it must keep. */
function authorizeRequest(app: RegisteredApp, { redirectUri = REDIRECT_URI, scope = 'openid email profile' } = {}) {
  const verifier = randomBytes(32).toString('base64url')
  const query = new URLSearchParams({
    client_id: app.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope,
    state: 'state-1',
    nonce: 'nonce-1',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  })
  return { verifier, url: `/api/auth/oauth2/authorize?${query.toString()}` }
}

/**
 * Signs `email` in through the sign-in page for `app`, then takes a code and
 * its verifier for each further request, as an app whose user has a session.
 */
async function signedInTo(issuer: Issuer, b: ReturnType<typeof browser>, app: RegisteredApp, email: string) {
  const first = authorizeRequest(app)
  const signInPage = new URL((await b.request(first.url)).headers.get('location') ?? '', ISSUER)
  const { code } = await requestCode(issuer, b, email)
  await b.request('/api/auth/sign-in/email-otp', { json: { email, otp: code, oauth_query: signInPage.search.slice(1) } })
  return async () => {
    const { url, verifier } = authorizeRequest(app)
    const back = new URL((await b.request(url)).headers.get('location') ?? '')
    return { code: back.searchParams.get('code') ?? '', verifier }
  }
}

function tokenRequest(issuer: Issuer, form: Record<string, string>) {
  return issuer.pub.request(`${AUTH}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
  })
}

describe('a closed issuer', () => {
  let issuer: Issuer
  let app: RegisteredApp
  let alice: { id: string }
  beforeAll(async () => {
    issuer = await startIssuer()
    app = await registerApp(issuer)
    alice = await adminJson(issuer, 'POST', '/api/users', { email: 'Alice@Example.com', name: 'Alice' })
  })
  afterAll(() => issuer.close())
  afterEach(() => vi.useRealTimers())

  test('signs a user in to an app by a mailed code', async () => {
    const b = browser(issuer)
    const { verifier, url } = authorizeRequest(app)

    const interrupted = await b.request(url)
    expect(interrupted.status).toBe(302)
    const signInPage = new URL(interrupted.headers.get('location') ?? '', ISSUER)
    expect(signInPage.pathname).toBe('/sign-in')

    const { code } = await requestCode(issuer, b, 'alice@example.com')
    expect(code).toMatch(/^\d{6}$/)
    // A plain hash of a six-digit code is undone by hashing all million, so it is stored keyed.
    const [stored] = await issuer.db.select().from(verifications)
    expect(stored?.value).not.toContain(createHash('sha256').update(code ?? '').digest('base64url'))
    const signedIn = await b.request('/api/auth/sign-in/email-otp', {
      json: { email: 'alice@example.com', otp: code, oauth_query: signInPage.search.slice(1) },
    })
    // `browser` takes only `__Host-` cookies, which no sibling site can set.
    expect([...b.cookies.keys()]).toEqual(['__Host-better-auth.session_token'])
    const { url: callback } = await signedIn.json() as { url: string }
    const back = new URL(callback)
    expect(back.origin + back.pathname).toBe(REDIRECT_URI)
    expect(back.searchParams.get('state')).toBe('state-1')

    const exchange = {
      grant_type: 'authorization_code',
      code: back.searchParams.get('code') ?? '',
      redirect_uri: REDIRECT_URI,
      client_id: app.clientId,
      code_verifier: verifier,
    }
    const refused = await tokenRequest(issuer, { ...exchange, client_secret: 'not-the-secret' })
    expect(refused.ok).toBe(false)
    const tokens = await tokenRequest(issuer, { ...exchange, client_secret: app.clientSecret })
    expect(tokens.status).toBe(200)
    const { id_token: idToken, access_token: accessToken } = await tokens.json() as Record<string, string>

    const jwks = await (await issuer.pub.request(`${AUTH}/jwks`)).json() as JSONWebKeySet
    const { payload, protectedHeader } = await jwtVerify(idToken ?? '', createLocalJWKSet(jwks), {
      issuer: ISSUER,
      audience: app.clientId,
    })
    expect(protectedHeader.alg).toBe('RS256')
    expect(payload).toMatchObject({ sub: alice.id, nonce: 'nonce-1', email: 'alice@example.com', email_verified: true })

    const userinfo = await issuer.pub.request(`${AUTH}/oauth2/userinfo`, {
      headers: { authorization: `Bearer ${accessToken}` },
    })
    expect(await userinfo.json()).toMatchObject({ sub: alice.id, email: 'alice@example.com', name: 'Alice' })

    // With a session, the next app's request needs no sign-in page.
    const again = await b.request(authorizeRequest(app).url)
    expect(again.headers.get('location')).toMatch(`${REDIRECT_URI}?code=`)

    // The log says who asked for a code, signed in, and got tokens for which app...
    const log = logged()
    const request = { listener: 'public', method: 'POST', ip: '203.0.113.7' }
    expect(log).toContainEqual(expect.objectContaining({
      ...request, path: '/api/auth/email-otp/send-verification-otp', status: 200, email: 'alice@example.com',
    }))
    expect(log).toContainEqual(expect.objectContaining({ ...request, path: '/api/auth/sign-in/email-otp', status: 200, email: 'alice@example.com' }))
    expect(log).toContainEqual(expect.objectContaining({
      path: '/api/auth/oauth2/token', status: 200, userId: alice.id, clientId: app.clientId, email: 'alice@example.com',
    }))
    // ...and holds no code, secret, token, cookie or query.
    const text = JSON.stringify(log)
    for (const secret of [code, app.clientSecret, verifier, idToken, accessToken, ...b.cookies.values(), 'state-1', 'nonce-1']) {
      expect(text).not.toContain(secret)
    }
  })

  test('refuses an authorization request without PKCE', async () => {
    const withPkce = new URL(authorizeRequest(app).url, ISSUER)
    withPkce.searchParams.delete('code_challenge')
    withPkce.searchParams.delete('code_challenge_method')
    const res = await browser(issuer).request(withPkce.pathname + withPkce.search)
    const back = new URL(res.headers.get('location') ?? '', ISSUER)
    expect(back.searchParams.get('error')).toBe('invalid_request')
    expect(back.searchParams.get('error_description')).toMatch(/pkce/i)
    expect(back.searchParams.has('code')).toBe(false)
  })

  test('mails no code to an address it does not know, and says nothing of it', async () => {
    const b = browser(issuer, '203.0.113.20')
    const { res, code } = await requestCode(issuer, b, 'mallory@example.com')
    expect(code).toBeUndefined()
    expect(res.status).toBe(200)
    const known = await requestCode(issuer, b, 'alice@example.com')
    expect(await res.json()).toEqual(await known.res.json())

    const guess = await b.request('/api/auth/sign-in/email-otp', { json: { email: 'mallory@example.com', otp: '000000' } })
    expect(guess.ok).toBe(false)
    expect(await adminJson(issuer, 'GET', '/api/users')).toHaveLength(1)
  })

  test('refuses a code after three wrong guesses', async () => {
    const [asker, guesser, second] = ['203.0.113.30', '203.0.113.31', '203.0.113.32'].map((ip) => browser(issuer, ip))
    const { code } = await requestCode(issuer, asker!, 'alice@example.com')
    const wrong = code === '111111' ? '222222' : '111111'
    for (let i = 0; i < 3; i++) {
      const res = await guesser!.request('/api/auth/sign-in/email-otp', { json: { email: 'alice@example.com', otp: wrong } })
      expect(res.ok).toBe(false)
    }
    const late = await second!.request('/api/auth/sign-in/email-otp', { json: { email: 'alice@example.com', otp: code } })
    expect(late.ok).toBe(false)
    expect(second!.cookies.size).toBe(0)
  })

  test('refuses a code five minutes after mailing it', async () => {
    const b = browser(issuer, '203.0.113.40')
    const { code } = await requestCode(issuer, b, 'alice@example.com')
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 5 * 60_000 + 1000 })
    const res = await b.request('/api/auth/sign-in/email-otp', { json: { email: 'alice@example.com', otp: code } })
    expect(res.ok).toBe(false)
  })

  test('limits how often one client may ask for a code', async () => {
    const b = browser(issuer, '203.0.113.50')
    const statuses = []
    for (let i = 0; i < 4; i++) statuses.push((await requestCode(issuer, b, 'nobody@example.com')).res.status)
    expect(statuses).toEqual([200, 200, 200, 429])
    const other = await requestCode(issuer, browser(issuer, '203.0.113.51'), 'nobody@example.com')
    expect(other.res.status).toBe(200)
  })

  test('ends the issuer session when an app signs out, so no app signs the browser in silently', async () => {
    await adminJson(issuer, 'POST', '/api/users', { email: 'henry@example.com' })
    const tasks = await adminJson<RegisteredApp>(issuer, 'POST', '/api/apps', { name: 'Tasks', redirectUris: [OTHER_REDIRECT_URI] })
    const b = browser(issuer, '203.0.113.100')

    const notes = authorizeRequest(app)
    const signInPage = new URL((await b.request(notes.url)).headers.get('location') ?? '', ISSUER)
    const { code } = await requestCode(issuer, b, 'henry@example.com')
    const signedIn = await b.request('/api/auth/sign-in/email-otp', {
      json: { email: 'henry@example.com', otp: code, oauth_query: signInPage.search.slice(1) },
    })
    const back = new URL((await signedIn.json() as { url: string }).url)
    const tokens = await (await tokenRequest(issuer, {
      grant_type: 'authorization_code',
      code: back.searchParams.get('code') ?? '',
      redirect_uri: REDIRECT_URI,
      client_id: app.clientId,
      client_secret: app.clientSecret,
      code_verifier: notes.verifier,
    })).json() as Record<string, string>
    // Apps keep their own sessions, so none is given a refresh token.
    expect(tokens.refresh_token).toBeUndefined()
    const toTasks = () => b.request(authorizeRequest(tasks, { redirectUri: OTHER_REDIRECT_URI }).url)
    expect((await toTasks()).headers.get('location')).toMatch(`${OTHER_REDIRECT_URI}?code=`)

    const logout = new URLSearchParams({ id_token_hint: tokens.id_token ?? '', post_logout_redirect_uri: 'https://app.example.com/' })
    const out = await b.request(`/api/auth/oauth2/end-session?${logout.toString()}`)
    expect(out.headers.get('location')).toBe('https://app.example.com/')
    expect(await (await b.request('/api/auth/get-session')).json()).toBeNull()
    expect(new URL((await toTasks()).headers.get('location') ?? '', ISSUER).pathname).toBe('/sign-in')

    const offline = await b.request(authorizeRequest(app, { scope: 'openid offline_access' }).url)
    expect(new URL(offline.headers.get('location') ?? '', ISSUER).searchParams.get('error')).toBe('invalid_scope')
  })

  test('signs a browser out by its own confirmation when an app\'s sign-out names no session', async () => {
    await adminJson(issuer, 'POST', '/api/users', { email: 'iris@example.com' })
    const b = browser(issuer, '203.0.113.101')
    const { code } = await requestCode(issuer, b, 'iris@example.com')
    await b.request('/api/auth/sign-in/email-otp', { json: { email: 'iris@example.com', otp: code } })

    // `browser` takes only cookies a browser would, so the confirmation's must be a `__Host-` cookie at `/`.
    const page = await b.request('/api/auth/oauth2/end-session', { headers: { accept: 'text/html' } })
    expect(await page.text()).toContain(`action="${AUTH}/oauth2/end-session/confirm"`)
    const confirmed = await b.request('/api/auth/oauth2/end-session/confirm', { form: { action: 'confirm' } })
    expect(confirmed.ok).toBe(true)
    expect(await (await b.request('/api/auth/get-session')).json()).toBeNull()
  })

  test('says when the sign-in page has gone stale, rather than calling a good code wrong', async () => {
    await adminJson(issuer, 'POST', '/api/users', { email: 'lena@example.com' })
    const b = browser(issuer, '203.0.113.110')
    const signInPage = new URL((await b.request(authorizeRequest(app).url)).headers.get('location') ?? '', ISSUER)
    // The app's request the page carries is good for ten minutes.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 11 * 60_000 })
    const { code } = await requestCode(issuer, b, 'lena@example.com')
    const res = await b.request('/api/auth/sign-in/email-otp', {
      json: { email: 'lena@example.com', otp: code, oauth_query: signInPage.search.slice(1) },
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ message: 'This sign-in page has expired. Go back to the app and sign in again.' })
  })

  test('sends a request it cannot send back to its app to the sign-in page', async () => {
    const res = await browser(issuer, '203.0.113.111').request(
      `/api/auth/oauth2/authorize?client_id=nope&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code`)
    const landed = new URL(res.headers.get('location') ?? '')
    expect(landed.origin + landed.pathname).toBe(`${ISSUER}/sign-in`)
    expect(landed.searchParams.get('error')).toBe('invalid_client')
  })

  test('stops a removed user\'s session, pending code and access token', async () => {
    const mona = await adminJson<{ id: string }>(issuer, 'POST', '/api/users', { email: 'mona@example.com' })
    const b = browser(issuer, '203.0.113.112')
    const nextCode = await signedInTo(issuer, b, app, 'mona@example.com')
    const redeem = async ({ code, verifier }: { code: string, verifier: string }) => tokenRequest(issuer, {
      grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, client_id: app.clientId, client_secret: app.clientSecret, code_verifier: verifier,
    })
    const { access_token: accessToken } = await (await redeem(await nextCode())).json() as Record<string, string>
    const pending = await nextCode()

    await adminJson(issuer, 'DELETE', `/api/users/${mona.id}`)
    expect(await (await b.request('/api/auth/get-session')).json()).toBeNull()
    expect((await redeem(pending)).ok).toBe(false)
    const userinfo = await issuer.pub.request(`${AUTH}/oauth2/userinfo`, { headers: { authorization: `Bearer ${accessToken}` } })
    expect(userinfo.status).toBe(401)
  })

  test('refuses an authorization code misdirected, redeemed by another app or replayed', async () => {
    await adminJson(issuer, 'POST', '/api/users', { email: 'nina@example.com' })
    const other = await adminJson<RegisteredApp>(issuer, 'POST', '/api/apps', { name: 'Other', redirectUris: ['https://other.example.com/cb'] })
    const b = browser(issuer, '203.0.113.113')
    const nextCode = await signedInTo(issuer, b, app, 'nina@example.com')
    const redeem = ({ code, verifier }: { code: string, verifier: string }, form: Record<string, string> = {}) => tokenRequest(issuer, Object.fromEntries(Object.entries({
      grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, client_id: app.clientId, client_secret: app.clientSecret, code_verifier: verifier, ...form,
    }).filter(([, value]) => value !== '')))

    const misdirected: Record<string, string>[] = [
      { client_id: other.clientId, client_secret: other.clientSecret },
      { redirect_uri: 'https://app.example.com/elsewhere' },
      { client_secret: '' },
      { code_verifier: '' },
    ]
    for (const form of misdirected) {
      expect((await redeem(await nextCode(), form)).ok, JSON.stringify(form)).toBe(false)
    }

    const issued = await nextCode()
    const { access_token: accessToken } = await (await redeem(issued)).json() as Record<string, string>
    const userinfo = () => issuer.pub.request(`${AUTH}/oauth2/userinfo`, { headers: { authorization: `Bearer ${accessToken}` } })
    // Another app learns nothing of the token and cannot revoke it.
    const asOther = (path: string) => issuer.pub.request(`${AUTH}/oauth2/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: accessToken ?? '', client_id: other.clientId, client_secret: other.clientSecret }),
    })
    expect(await (await asOther('introspect')).json()).toMatchObject({ active: false })
    await asOther('revoke')
    expect((await userinfo()).status).toBe(200)

    // A replayed code is refused and takes the token issued for it with it.
    expect((await redeem(issued)).ok).toBe(false)
    expect((await userinfo()).status).toBe(401)
  })

  test('takes apps\' token requests from one address well past better-auth\'s default of 20 a minute', async () => {
    // Apps on one cluster share an egress address; a bad secret still counts against the limit.
    const statuses = new Set<number>()
    for (let i = 0; i < 25; i++) {
      const res = await issuer.pub.request(`${AUTH}/oauth2/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': '198.51.103.1' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'x', client_id: app.clientId, client_secret: 'wrong' }),
      })
      statuses.add(res.status)
    }
    expect(statuses.has(429)).toBe(false)
  })

  test('names its public URL in discovery whatever Host a request carries', async () => {
    const res = await issuer.pub.request('http://evil.example/.well-known/openid-configuration', {
      headers: { 'host': 'evil.example', 'x-forwarded-host': 'evil.example' },
    })
    const doc = await res.json() as Record<string, unknown>
    expect(doc).toMatchObject({
      issuer: ISSUER,
      authorization_endpoint: `${AUTH}/oauth2/authorize`,
      token_endpoint: `${AUTH}/oauth2/token`,
      userinfo_endpoint: `${AUTH}/oauth2/userinfo`,
      jwks_uri: `${AUTH}/jwks`,
      grant_types_supported: ['authorization_code'],
      scopes_supported: ['openid', 'profile', 'email'],
      id_token_signing_alg_values_supported: ['RS256'],
      // A client library takes the first method offered; apps use this one alone.
      token_endpoint_auth_methods_supported: ['client_secret_post'],
    })
    expect(doc).not.toHaveProperty('backchannel_logout_supported')
    expect(doc).not.toHaveProperty('dpop_signing_alg_values_supported')
    expect(JSON.stringify(doc)).not.toContain('evil.example')
  })

  test('serves nothing that registers an app, adds a user or changes an account', async () => {
    const b = browser(issuer, '203.0.113.60')
    const { code } = await requestCode(issuer, b, 'alice@example.com')
    await b.request('/api/auth/sign-in/email-otp', { json: { email: 'alice@example.com', otp: code } })
    const session = await b.request('/api/auth/get-session')
    expect((await session.json() as { user: { id: string } }).user.id).toBe(alice.id)
    expect(session.headers.get('set-auth-jwt')).toBeNull()

    const client = { client_name: 'Evil', redirect_uris: ['https://evil.example/cb'] }
    const closed: [string, unknown][] = [
      ['/api/apps', { name: 'Evil', redirectUris: ['https://evil.example/cb'] }],
      ['/api/users', { email: 'mallory@example.com' }],
      ['/api/auth/admin/oauth2/create-client', client],
      ['/api/auth/oauth2/create-client', client],
      ['/api/auth/oauth2/register', client],
      ['/api/auth/sign-up/email', { email: 'mallory@example.com', password: 'password-1234', name: 'M' }],
      ['/api/auth/update-user', { name: 'Not Alice' }],
      ['/api/auth/delete-user', {}],
      ['/api/auth/email-otp/request-email-change', { newEmail: 'mallory@example.com' }],
    ]
    for (const [route, json] of closed) {
      expect((await b.request(route, { json })).status, route).toBe(404)
    }
    // The list is checked against the path as sent, as better-auth's router reads it.
    expect(await (await b.request('/api/auth/%67et-session')).text()).toBe('404 Not Found')

    // Were a route that registers a client ever served, a session still buys nothing.
    const cookie = [...b.cookies].map(([name, value]) => `${name}=${value}`).join('; ')
    await expect(issuer.auth.api.getSession({ headers: new Headers({ cookie }) })).resolves.toMatchObject({ user: { id: alice.id } })
    await expect(issuer.auth.api.createOAuthClient({ headers: new Headers({ cookie }), body: client }))
      .rejects.toMatchObject({ status: 'UNAUTHORIZED' })
    // The route that registers an app is better-auth's server-only, even past the route list.
    const direct = await issuer.auth.handler(new Request(`${AUTH}/admin/oauth2/create-client`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'origin': ISSUER },
      body: JSON.stringify(client),
    }))
    expect(direct.status).toBe(404)

    expect(await adminJson(issuer, 'GET', '/api/apps')).not.toContainEqual(expect.objectContaining({ name: 'Evil' }))
    const users = await adminJson<{ email: string, name: string }[]>(issuer, 'GET', '/api/users')
    expect(users).toContainEqual(expect.objectContaining({ email: 'alice@example.com', name: 'Alice' }))
    expect(users).not.toContainEqual(expect.objectContaining({ email: 'mallory@example.com' }))
  })

  test('sends one address a few codes an hour, however many clients ask', async () => {
    await adminJson(issuer, 'POST', '/api/users', { email: 'carol@example.com' })
    for (const email of ['carol@example.com', 'dave@example.com']) {
      const statuses = []
      for (let i = 0; i <= CODES_PER_ADDRESS; i++) {
        statuses.push((await requestCode(issuer, browser(issuer, `198.51.100.${i}`), email)).res.status)
      }
      // The same for an address that may not sign in, so the limit tells no one which is which.
      expect(statuses, email).toEqual([...Array<number>(CODES_PER_ADDRESS).fill(200), 429])
    }
    expect(issuer.mail.filter((m) => m.email === 'carol@example.com')).toHaveLength(CODES_PER_ADDRESS)

    // Codes of other kinds are refused, and so cannot use up anyone's limit.
    await adminJson(issuer, 'POST', '/api/users', { email: 'grace@example.com' })
    for (let i = 0; i <= CODES_PER_ADDRESS; i++) {
      const res = await browser(issuer, `198.51.101.${i}`).request('/api/auth/email-otp/send-verification-otp', {
        json: { email: 'grace@example.com', type: 'forget-password' },
      })
      expect(res.status).toBe(400)
    }
    expect((await requestCode(issuer, browser(issuer, '198.51.101.99'), 'grace@example.com')).code).toMatch(/^\d{6}$/)

    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 60 * 60_000 + 1000 })
    expect((await requestCode(issuer, browser(issuer, '198.51.100.99'), 'carol@example.com')).code).toMatch(/^\d{6}$/)
  })

  test('answers wrong guesses alike for an address that may sign in and one that may not', async () => {
    await adminJson(issuer, 'POST', '/api/users', { email: 'frank@example.com' })
    let ip = 0
    async function guesses(email: string, times: number) {
      const answers = []
      for (let i = 0; i < times; i++) {
        const res = await browser(issuer, `198.51.102.${++ip}`).request('/api/auth/sign-in/email-otp', { json: { email, otp: '000000' } })
        answers.push([res.status, await res.json()])
      }
      return answers
    }
    const ask = async (email: string) => (await requestCode(issuer, browser(issuer, `198.51.102.${++ip}`), email)).res.status
    // Past the three guesses a code allows.
    expect([await ask('frank@example.com'), await ask('ivan@example.com')]).toEqual([200, 200])
    expect(await guesses('frank@example.com', 5)).toEqual(await guesses('ivan@example.com', 5))
    // After a code expires.
    expect([await ask('frank@example.com'), await ask('ivan@example.com')]).toEqual([200, 200])
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 5 * 60_000 + 1000 })
    expect(await guesses('frank@example.com', 1)).toEqual(await guesses('ivan@example.com', 1))
  })

  test('takes the sign-in page\'s calls from that page alone', async () => {
    const elsewhere = [
      { origin: 'https://notes.example.com' },
      { 'origin': ISSUER, 'sec-fetch-site': 'same-site' },
      { origin: 'null' },
    ]
    for (const route of ['email-otp/send-verification-otp', 'sign-in/email-otp', 'sign-out']) {
      for (const headers of elsewhere) {
        const res = await issuer.pub.request(`${AUTH}/${route}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.70', ...headers },
          body: JSON.stringify({ email: 'alice@example.com', type: 'sign-in', otp: '000000' }),
        })
        expect(res.status, `${route} ${JSON.stringify(headers)}`).toBe(403)
      }
    }
  })

  test('refuses a body over its limit, however it is sent, before anything reads it', async () => {
    const big = JSON.stringify({ email: 'alice@example.com', type: 'sign-in', pad: 'x'.repeat(40 * 1024) })
    const send = (headers: Record<string, string>) => issuer.pub.request(`${AUTH}/email-otp/send-verification-otp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'origin': ISSUER, 'x-forwarded-for': '203.0.113.95', ...headers },
      body: big,
    })
    const before = issuer.mail.length
    // With no length given, as a chunked body arrives; and with one.
    expect((await send({})).status).toBe(413)
    expect((await send({ 'content-length': String(big.length) })).status).toBe(413)
    expect(issuer.mail.length).toBe(before)
    expect(logged()).toContainEqual(expect.objectContaining({ path: '/api/auth/email-otp/send-verification-otp', status: 413 }))
  })

  test('signs no one in by a header', async () => {
    const res = await issuer.pub.request(`${AUTH}/get-session`, {
      headers: { 'tailscale-user-login': 'alice@example.com', 'x-forwarded-user': 'alice@example.com' },
    })
    expect(await res.json()).toBeNull()
  })

  test('serves the sign-in page and its assets', async () => {
    for (const route of ['/', '/sign-in?client_id=x', '/consent']) {
      expect(await (await issuer.pub.request(route)).text(), route).toContain('<title>sign-in</title>')
    }
    const page = await issuer.pub.request('/sign-in')
    expect(page.headers.get('content-security-policy')).toContain('frame-ancestors \'none\'')
    expect(page.headers.get('x-content-type-options')).toBe('nosniff')
    expect((await issuer.pub.request('/assets/a.js')).status).toBe(200)
    expect((await issuer.pub.request('/admin.html')).status).toBe(404)
    expect(await (await issuer.pub.request('/health')).text()).toBe('ok')
  })
})

describe('an open issuer', () => {
  test('creates the user on a first sign-in, with no name of their choosing', async () => {
    const issuer = await startIssuer({ openSignUp: true })
    const b = browser(issuer)
    const { code } = await requestCode(issuer, b, 'new@example.com')
    const res = await b.request('/api/auth/sign-in/email-otp', {
      json: { email: 'new@example.com', otp: code, name: 'Alice (admin)', image: 'https://evil.example/a.png' },
    })
    expect(res.status).toBe(200)
    expect(await adminJson(issuer, 'GET', '/api/users')).toEqual([expect.objectContaining({ email: 'new@example.com', name: '' })])
    await issuer.close()
  })
})

describe('an issuer whose mail fails', () => {
  test('answers at once whatever the mail does, and drops a code that was never delivered', async () => {
    let failing = true
    // Fails, or never finishes: the answer waits for neither.
    const issuer = await startIssuer({ openSignUp: true }, () => failing ? Promise.reject(new Error('refused')) : new Promise(() => {}))
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const b = browser(issuer, '203.0.113.80')

    const { res, code } = await requestCode(issuer, b, 'erin@example.com')
    expect(res.status).toBe(200)
    await vi.waitFor(async () => expect(await issuer.db.select().from(verifications)).toEqual([]))
    const guess = await b.request('/api/auth/sign-in/email-otp', { json: { email: 'erin@example.com', otp: code } })
    expect(guess.ok).toBe(false)

    failing = false
    expect((await requestCode(issuer, b, 'erin@example.com')).res.status).toBe(200)
    errors.mockRestore()
    await issuer.close()
  })

  test('withdraws only the code whose mail failed, not one mailed after it', async () => {
    const deliveries: { resolve: () => void, reject: (error: Error) => void }[] = []
    const issuer = await startIssuer({}, () => new Promise<void>((resolve, reject) => {
      deliveries.push({ resolve, reject })
    }))
    await adminJson(issuer, 'POST', '/api/users', { email: 'erin@example.com' })
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const b = browser(issuer, '203.0.113.81')

    await requestCode(issuer, b, 'erin@example.com')
    const { code } = await requestCode(issuer, b, 'erin@example.com')
    // The second mail arrives; then the first, still pending, fails.
    deliveries[1]!.resolve()
    deliveries[0]!.reject(new Error('timed out'))
    await vi.waitFor(() => expect(errors).toHaveBeenCalledWith(expect.stringContaining('withdrawn')))

    const res = await b.request('/api/auth/sign-in/email-otp', { json: { email: 'erin@example.com', otp: code } })
    expect(res.status).toBe(200)
    errors.mockRestore()
    await issuer.close()
  })
})
