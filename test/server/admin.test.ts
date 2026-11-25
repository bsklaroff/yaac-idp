import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { adminJson, browser, logged, REDIRECT_URI, requestCode, startIssuer, type Issuer } from './support.ts'

function post(issuer: Issuer, route: string, body: unknown, headers: Record<string, string> = {}) {
  return issuer.admin.request(`http://localhost:3001${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'host': 'localhost:3001', ...headers },
    body: JSON.stringify(body),
  })
}

describe('the admin listener', () => {
  let issuer: Issuer
  beforeAll(async () => {
    issuer = await startIssuer()
  })
  afterAll(() => issuer.close())

  test('registers, lists and removes apps', async () => {
    const app = await adminJson<{ clientId: string, clientSecret: string }>(
      issuer, 'POST', '/api/apps', { name: ' Notes ', redirectUris: [REDIRECT_URI] })
    expect(app).toMatchObject({ name: 'Notes', redirectUris: [REDIRECT_URI] })
    expect(app.clientSecret).toMatch(/\w{32}/)

    const listed = await adminJson<Record<string, unknown>[]>(issuer, 'GET', '/api/apps')
    expect(listed).toEqual([expect.objectContaining({ clientId: app.clientId, name: 'Notes' })])
    expect(JSON.stringify(listed)).not.toContain(app.clientSecret)

    for (const bad of [{ name: '', redirectUris: [REDIRECT_URI] }, { name: 'x', redirectUris: [] }, { name: 'x', redirectUris: ['nope'] }, { name: 'x', redirectUris: ['javascript:alert(1)'] }, { name: 'x', redirectUris: ['https://app.example.com/cb#x'] }, { name: 'x', redirectUris: ['https://user:pw@app.example.com/cb'] }]) {
      expect((await post(issuer, '/api/apps', bad)).status).toBe(400)
    }
    // The provider's own refusals say why, rather than failing the request.
    for (const uri of ['http://app.example.com/cb', 'http://localhost:3000/cb']) {
      const refused = await post(issuer, '/api/apps', { name: 'x', redirectUris: [uri] })
      expect(refused.status, uri).toBe(400)
      expect((await refused.json() as { error: string }).error, uri).toMatch(/redirect URI/)
    }

    await adminJson(issuer, 'DELETE', `/api/apps/${app.clientId}`)
    expect(await adminJson(issuer, 'GET', '/api/apps')).toEqual([])
    expect(logged()).toEqual(expect.arrayContaining([
      expect.objectContaining({ listener: 'admin', method: 'POST', path: '/api/apps', status: 201, clientId: app.clientId, name: 'Notes', redirectUris: REDIRECT_URI }),
      expect.objectContaining({ method: 'DELETE', path: `/api/apps/${app.clientId}`, status: 204, clientId: app.clientId, name: 'Notes' }),
    ]))
    expect(JSON.stringify(logged())).not.toContain(app.clientSecret)
    expect((await issuer.admin.request(`/api/apps/${app.clientId}`, { method: 'DELETE' })).status).toBe(404)
  })

  test('adds, lists and removes users', async () => {
    const bob = await adminJson<{ id: string }>(issuer, 'POST', '/api/users', { email: 'Bob@Example.com' })
    expect(bob).toMatchObject({ email: 'bob@example.com', name: '' })
    expect((await post(issuer, '/api/users', { email: 'bob@example.com' })).status).toBe(409)
    expect((await post(issuer, '/api/users', { email: 'bob@github' })).status).toBe(400)
    expect(await adminJson(issuer, 'GET', '/api/users')).toHaveLength(1)

    await adminJson(issuer, 'DELETE', `/api/users/${bob.id}`)
    expect(await adminJson(issuer, 'GET', '/api/users')).toEqual([])
    expect(logged()).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: 'POST', path: '/api/users', status: 201, userId: bob.id, email: 'bob@example.com' }),
      expect.objectContaining({ method: 'DELETE', path: `/api/users/${bob.id}`, status: 204, userId: bob.id, email: 'bob@example.com' }),
    ]))
    expect((await issuer.admin.request(`/api/users/${bob.id}`, { method: 'DELETE' })).status).toBe(404)
  })

  test('takes an app run on this machine when the issuer runs here too', async () => {
    const local = await startIssuer({ publicUrl: 'http://localhost:5173' })
    expect((await adminJson<{ redirectUris: string[] }>(local, 'POST', '/api/apps', { name: 'Dev', redirectUris: ['http://localhost:3000/cb'] }))
      .redirectUris).toEqual(['http://localhost:3000/cb'])
    expect((await post(local, '/api/apps', { name: 'x', redirectUris: ['http://app.example.com/cb'] })).status).toBe(400)
    await local.close()
  })

  test('signs a user out of the issuer everywhere, keeping their account', async () => {
    const owen = await adminJson<{ id: string }>(issuer, 'POST', '/api/users', { email: 'owen@example.com' })
    const b = browser(issuer, '203.0.113.91')
    const { code } = await requestCode(issuer, b, 'owen@example.com')
    await b.request('/api/auth/sign-in/email-otp', { json: { email: 'owen@example.com', otp: code } })
    expect(await (await b.request('/api/auth/get-session')).json()).toMatchObject({ user: { id: owen.id } })

    await adminJson(issuer, 'POST', `/api/users/${owen.id}/sign-out`)
    expect(await (await b.request('/api/auth/get-session')).json()).toBeNull()
    expect(await adminJson(issuer, 'GET', '/api/users')).toContainEqual(expect.objectContaining({ id: owen.id, email: 'owen@example.com' }))
    expect(logged()).toContainEqual(expect.objectContaining({ path: `/api/users/${owen.id}/sign-out`, status: 204, userId: owen.id }))
    expect((await post(issuer, '/api/users/nobody/sign-out', {})).status).toBe(404)
  })

  test('withdraws a code out for an address when its user is removed, so it cannot sign in the user added again', async () => {
    const dana = await adminJson<{ id: string }>(issuer, 'POST', '/api/users', { email: 'dana@example.com' })
    const b = browser(issuer, '203.0.113.90')
    const { code } = await requestCode(issuer, b, 'dana@example.com')
    expect(code).toMatch(/^\d{6}$/)

    await adminJson(issuer, 'DELETE', `/api/users/${dana.id}`)
    await adminJson(issuer, 'POST', '/api/users', { email: 'dana@example.com' })
    const res = await b.request('/api/auth/sign-in/email-otp', { json: { email: 'dana@example.com', otp: code } })
    expect(res.status).toBe(400)
    expect(b.cookies.size).toBe(0)
  })

  test('refuses what another page sent, and takes its own page\'s', async () => {
    const user = { email: 'carol@example.com' }
    const elsewhere: Record<string, string>[] = [
      { origin: 'https://evil.example' },
      { origin: 'http://localhost:5173' },
      { origin: 'null' },
      { 'sec-fetch-site': 'same-site' },
      { 'sec-fetch-site': 'cross-site' },
    ]
    for (const headers of elsewhere) {
      expect((await post(issuer, '/api/users', user, headers)).status, JSON.stringify(headers)).toBe(403)
    }
    const preflight = await issuer.admin.request('http://localhost:3001/api/users', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } })
    expect(preflight.status).toBe(403)
    expect(await adminJson(issuer, 'GET', '/api/users')).not.toContainEqual(expect.objectContaining(user))

    expect((await post(issuer, '/api/users', user, { 'origin': 'http://localhost:3001', 'sec-fetch-site': 'same-origin' })).status).toBe(201)
    // Another page may link to this one.
    const linked = await issuer.admin.request('http://localhost:3001/', {
      headers: { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' },
    })
    expect(linked.status).toBe(200)
  })

  test('answers only at a loopback name, so a page that points its own name here gets nothing', async () => {
    for (const host of ['evil.example:3001', '192.168.1.5:3001', 'localhost.evil.example:3001']) {
      const read = await issuer.admin.request(`http://${host}/api/users`, { headers: { host } })
      expect(read.status, host).toBe(403)
      const write = await post(issuer, '/api/users', { email: 'mallory@evil.example' }, { host, origin: `http://${host}` })
      expect(write.status, host).toBe(403)
    }
    for (const host of ['127.0.0.1:3001', '[::1]:3001', '3001.ab12cd34.localhost:3001']) {
      expect((await issuer.admin.request(`http://${host}/api/settings`, { headers: { host } })).status, host).toBe(200)
    }
    expect(await adminJson(issuer, 'GET', '/api/users')).not.toContainEqual(expect.objectContaining({ email: 'mallory@evil.example' }))
  })

  test('is ready once its database answers, and not while it does not', async () => {
    const own = await startIssuer()
    expect((await own.admin.request('/ready')).status).toBe(200)
    await own.close()
    expect((await own.admin.request('/ready')).status).toBe(503)
  })

  test('serves its page and the issuer\'s settings', async () => {
    const page = await issuer.admin.request('/')
    expect(await page.text()).toContain('<title>admin</title>')
    expect(page.headers.get('content-security-policy')).toContain('frame-ancestors \'none\'')
    expect(await adminJson(issuer, 'GET', '/api/settings')).toEqual({ issuer: 'https://auth.example.com', openSignUp: false })
  })
})
