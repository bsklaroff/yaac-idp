import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { Admin } from '#web/admin/Admin.tsx'
import { createAdminStore, type App, type User } from '#web/admin/store.ts'

/** The admin listener's routes over two arrays. */
function fakeIssuer(openSignUp = false) {
  const apps: App[] = []
  const users: User[] = [{ id: 'u1', email: 'alice@example.com', name: 'Alice' }]
  const json = (body: unknown, status = 200) => Promise.resolve(Response.json(body, { status }))
  const fetchFn = vi.fn<typeof fetch>((input, init) => {
    const route = `${init?.method ?? 'GET'} ${new URL(input as string).pathname}`
    const body = init?.body ? JSON.parse(init.body as string) as Omit<App, 'clientId'> : { name: '', redirectUris: [] }
    if (route === 'GET /api/settings') return json({ issuer: 'https://auth.example.com', openSignUp })
    if (route === 'GET /api/apps') return json(apps)
    if (route === 'GET /api/users') return json(users)
    if (route === 'POST /api/apps') {
      apps.push({ clientId: 'client-1', ...body })
      return json({ clientId: 'client-1', clientSecret: 'secret-1', ...body }, 201)
    }
    if (route === 'POST /api/users') return json({ error: 'a user with that email exists' }, 409)
    if (route === 'POST /api/users/u1/sign-out') return Promise.resolve(new Response(null, { status: 204 }))
    if (route === 'DELETE /api/users/u1') {
      users.length = 0
      return Promise.resolve(new Response(null, { status: 204 }))
    }
    return json({ error: `no route ${route}` }, 404)
  })
  return { fetchFn, apps, users }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Admin', () => {
  test('registers an app and shows its secret once', async () => {
    const { fetchFn } = fakeIssuer()
    render(<Admin store={createAdminStore(fetchFn)} />)
    await screen.findByText(/is closed/)

    const apps = within(screen.getByRole('region', { name: 'Apps' }))
    fireEvent.change(apps.getByLabelText('App name'), { target: { value: 'Notes' } })
    fireEvent.change(apps.getByLabelText(/Redirect URIs/), {
      target: { value: 'https://notes.example.com/cb\nhttps://notes.example.com/cb2' },
    })
    fireEvent.click(apps.getByRole('button', { name: 'Register app' }))

    const created = within(await screen.findByRole('region', { name: 'New app' }))
    expect(created.getByText('secret-1')).toBeTruthy()
    expect(created.getByText('client-1')).toBeTruthy()
    expect(JSON.parse(fetchFn.mock.calls.find(([, init]) => init?.method === 'POST')?.[1]?.body as string)).toEqual({
      name: 'Notes',
      redirectUris: ['https://notes.example.com/cb', 'https://notes.example.com/cb2'],
    })
    await apps.findByText('https://notes.example.com/cb, https://notes.example.com/cb2')

    fireEvent.click(created.getByRole('button', { name: 'Done' }))
    expect(screen.queryByText('secret-1')).toBeNull()
  })

  test.each([false, true])('shows a refusal, and removes a user once told what removal leaves (open sign-up: %s)', async (openSignUp) => {
    const { fetchFn } = fakeIssuer(openSignUp)
    const confirm = vi.fn(() => true)
    vi.stubGlobal('confirm', confirm)
    render(<Admin store={createAdminStore(fetchFn)} />)
    await screen.findByText(openSignUp ? /is open/ : /is closed/)
    const users = within(screen.getByRole('region', { name: 'Users' }))
    await users.findByText('alice@example.com')

    fireEvent.change(users.getByLabelText('Email'), { target: { value: 'alice@example.com' } })
    fireEvent.click(users.getByRole('button', { name: 'Add user' }))
    expect((await screen.findByRole('alert')).textContent).toBe('a user with that email exists')

    fireEvent.click(users.getByRole('button', { name: 'Sign out alice@example.com' }))
    await vi.waitFor(() => expect(fetchFn.mock.calls.some(([url, init]) =>
      init?.method === 'POST' && new URL(url as string).pathname === '/api/users/u1/sign-out')).toBe(true))
    confirm.mockClear()

    fireEvent.click(users.getByRole('button', { name: 'Remove alice@example.com' }))
    await users.findByText('No users yet.')
    expect(screen.queryByRole('alert')).toBeNull()
    const [notice] = confirm.mock.calls[0] as unknown as [string]
    expect(notice).toContain('each app keeps its own session for them until it ends')
    expect(notice).toContain(openSignUp ? 'they can sign in again at once' : 'Adding them again gives them a new id')
  })
})
