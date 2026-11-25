import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { signInApi } from '#web/sign-in/api.ts'
import { SignIn } from '#web/sign-in/SignIn.tsx'
import { createSignInStore, type SignInApi } from '#web/sign-in/store.ts'

function fakeApi(overrides: Partial<SignInApi> = {}): SignInApi {
  return {
    sendCode: vi.fn(() => Promise.resolve(null)),
    verify: vi.fn(() => Promise.resolve(null)),
    session: vi.fn(() => Promise.resolve(null)),
    signOut: vi.fn(() => Promise.resolve(null)),
    ...overrides,
  }
}

function submit(label: string, value: string, button: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
  fireEvent.click(screen.getByRole('button', { name: button }))
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('SignIn', () => {
  test('takes an address, then the code mailed to it, for an app', async () => {
    const api = fakeApi()
    render(<SignIn store={createSignInStore(api)} forApp />)

    submit('Email', ' alice@example.com ', 'Email me a code')
    await screen.findByText(/alice@example.com may sign in here/)
    expect(api.sendCode).toHaveBeenCalledWith('alice@example.com')

    submit('Code', '123456', 'Sign in')
    await screen.findByText(/Returning to the app/)
    expect(api.verify).toHaveBeenCalledWith('alice@example.com', '123456')
    expect(api.session).not.toHaveBeenCalled()
  })

  test('shows a refusal and lets the person start over', async () => {
    const api = fakeApi({ verify: () => Promise.resolve('Invalid OTP') })
    render(<SignIn store={createSignInStore(api)} forApp />)
    submit('Email', 'alice@example.com', 'Email me a code')
    await screen.findByLabelText('Code')
    submit('Code', '000000', 'Sign in')
    expect((await screen.findByRole('alert')).textContent).toBe('Invalid OTP')

    fireEvent.click(screen.getByRole('button', { name: 'Use another address' }))
    expect(screen.getByLabelText<HTMLInputElement>('Email').value).toBe('alice@example.com')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  test('with no app waiting, shows who is signed in and signs them out', async () => {
    const api = fakeApi({ session: () => Promise.resolve('alice@example.com') })
    render(<SignIn store={createSignInStore(api)} forApp={false} />)
    await screen.findByText(/You are signed in as alice@example.com/)
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    await screen.findByLabelText('Email')
    expect(api.signOut).toHaveBeenCalled()
  })

  test('keeps showing who is signed in when signing out fails, and tries again', async () => {
    const signOut = vi.fn<SignInApi['signOut']>()
      .mockResolvedValueOnce('Something went wrong. Try again.')
      .mockResolvedValueOnce(null)
    render(<SignIn store={createSignInStore(fakeApi({ session: () => Promise.resolve('alice@example.com'), signOut }))} forApp={false} />)
    await screen.findByText(/You are signed in as alice@example.com/)

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Something went wrong. Try again.')
    expect(screen.getByText(/You are signed in as alice@example.com/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    await screen.findByLabelText('Email')
    expect(signOut).toHaveBeenCalledTimes(2)
  })
})

describe('signInApi', () => {
  test('answers a refusal and a lost connection with a message, never a throw', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(Response.json({ message: 'no session' }, { status: 500 }))))
    await expect(signInApi().signOut()).resolves.toBe('no session')
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))))
    await expect(signInApi().signOut()).resolves.toBe('Something went wrong. Try again.')
    await expect(signInApi().sendCode('alice@example.com')).resolves.toBe('Something went wrong. Try again.')
  })
})
