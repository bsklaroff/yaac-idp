import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { readConfig } from '#server/config.ts'

const base = {
  IDP_PUBLIC_URL: 'https://auth.example.com',
  BETTER_AUTH_SECRET: 's'.repeat(32),
  RESEND_API_KEY: 'key',
  IDP_MAIL_FROM: 'auth@example.com',
}

describe('readConfig', () => {
  test('is closed, on the default ports and under the site volume by default', () => {
    expect(readConfig({ ...base, YAAC_VOLUME_DIR: '/vol' })).toEqual({
      publicUrl: 'https://auth.example.com',
      secret: base.BETTER_AUTH_SECRET,
      dataDir: '/vol/pg',
      dumpPath: '/vol/pre-migrate.tar.gz',
      port: 3000,
      adminPort: 3001,
      openSignUp: false,
      name: 'auth.example.com',
      mail: { apiKey: 'key', from: 'auth@example.com' },
    })
  })

  test('reads every setting', () => {
    const config = readConfig({
      ...base,
      IDP_DATA_DIR: 'state',
      YAAC_VOLUME_DIR: '/vol',
      IDP_PORT: '8080',
      IDP_ADMIN_PORT: '8081',
      IDP_OPEN_SIGNUP: 'true',
      IDP_NAME: 'Example',
      RESEND_API_KEY: 'key',
      IDP_MAIL_FROM: 'Example <auth@example.com>',
    })
    expect(config).toMatchObject({
      dataDir: path.resolve('state/pg'),
      port: 8080,
      adminPort: 8081,
      openSignUp: true,
      name: 'Example',
      mail: { apiKey: 'key', from: 'Example <auth@example.com>' },
    })
  })

  test('takes a plain http URL on localhost alone, for development', () => {
    expect(readConfig({ ...base, IDP_PUBLIC_URL: 'http://localhost:5173' }).publicUrl).toBe('http://localhost:5173')
  })

  test('prints codes only when asked to by name, and only on localhost', () => {
    const local = { ...base, IDP_PUBLIC_URL: 'http://localhost:5173', RESEND_API_KEY: undefined }
    expect(readConfig({ ...local, IDP_PRINT_CODES: 'true' }).mail).toBeNull()
    expect(() => readConfig({ ...base, IDP_PRINT_CODES: 'true' })).toThrow('IDP_PRINT_CODES is for an issuer on localhost alone')
  })

  test.each([
    [{ IDP_PUBLIC_URL: undefined }, 'IDP_PUBLIC_URL is not set'],
    [{ IDP_PUBLIC_URL: 'https://auth.example.com/idp' }, 'must be an origin'],
    [{ IDP_PUBLIC_URL: 'http://auth.example.com' }, 'must be https'],
    [{ BETTER_AUTH_SECRET: 'short' }, 'at least 32'],
    [{ IDP_PORT: 'http' }, 'IDP_PORT is not a port'],
    [{ IDP_ADMIN_PORT: '3000' }, 'must differ'],
    [{ RESEND_API_KEY: undefined }, 'RESEND_API_KEY is not set'],
    [{ IDP_MAIL_FROM: undefined }, 'IDP_MAIL_FROM is not set'],
  ])('refuses %j', (env, message) => {
    expect(() => readConfig({ ...base, ...env })).toThrow(message)
  })
})
