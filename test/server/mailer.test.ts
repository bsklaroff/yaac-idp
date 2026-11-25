import { describe, expect, test, vi } from 'vitest'
import { resendMailer } from '#server/mailer.ts'

describe('resendMailer', () => {
  const mail = { apiKey: 'placeholder', from: 'Example <auth@example.com>' }

  test('posts the code to the provider with the key as a bearer token', async () => {
    const fetchFn = vi.fn<typeof fetch>(() => Promise.resolve(new Response('{}')))
    await resendMailer(mail, 'Example', fetchFn).sendCode('alice@example.com', '123456')
    const [url, init] = fetchFn.mock.calls[0]!
    expect(url).toBe('https://api.resend.com/emails')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer placeholder')
    // A provider that never answers does not hold a sending forever.
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    expect(JSON.parse(init?.body as string)).toMatchObject({
      from: mail.from,
      to: ['alice@example.com'],
      subject: '123456 is your Example sign-in code',
    })
  })

  test('fails when the provider refuses', async () => {
    const fetchFn = () => Promise.resolve(new Response('no', { status: 422 }))
    await expect(resendMailer(mail, 'Example', fetchFn).sendCode('a@example.com', '1')).rejects.toThrow('422')
  })
})
