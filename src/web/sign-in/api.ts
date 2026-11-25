/**
 * The sign-in page's calls to the issuer, through better-auth's client. Its
 * provider plugin sends the page's signed query with a sign-in, and the
 * client follows the answer back to the app that asked.
 */
import { createAuthClient } from 'better-auth/client'
import { emailOTPClient } from 'better-auth/client/plugins'
import { oauthProviderClient } from '@better-auth/oauth-provider/client'
import type { SignInApi } from './store.ts'

const DEFAULT_ERROR = 'Something went wrong. Try again.'

/**
 * Runs a call, resolving to its error message or null. better-auth's client
 * answers a refusal with `error`, but a lost connection may throw instead.
 */
async function attempt(call: () => Promise<{ error: { message?: string } | null }>): Promise<string | null> {
  try {
    const { error } = await call()
    return error ? (error.message ?? DEFAULT_ERROR) : null
  } catch {
    return DEFAULT_ERROR
  }
}

export function signInApi(): SignInApi {
  const client = createAuthClient({ plugins: [emailOTPClient(), oauthProviderClient()] })
  return {
    sendCode: (email) => attempt(() => client.emailOtp.sendVerificationOtp({ email, type: 'sign-in' })),
    verify: (email, code) => attempt(() => client.signIn.emailOtp({ email, otp: code })),
    async session() {
      const { data } = await client.getSession()
      return data?.user.email ?? null
    },
    signOut: () => attempt(() => client.signOut()),
  }
}
