/**
 * Sends sign-in codes. Mail goes through a provider's HTTPS API (Resend),
 * since a yaac release's egress carries only HTTP. Under yaac the API key is
 * a placeholder that the egress proxy replaces in the Authorization header.
 */
import type { Config } from './config.ts'

export interface Mailer {
  sendCode(email: string, code: string): Promise<void>
}

export function resendMailer(mail: NonNullable<Config['mail']>, name: string, fetchFn: typeof fetch = fetch): Mailer {
  return {
    async sendCode(email, code) {
      const res = await fetchFn('https://api.resend.com/emails', {
        method: 'POST',
        signal: AbortSignal.timeout(10_000),
        headers: { 'authorization': `Bearer ${mail.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          from: mail.from,
          to: [email],
          subject: `${code} is your ${name} sign-in code`,
          text: `Your sign-in code for ${name} is ${code}.\n\nIt is good for five minutes. If you did not ask for it, ignore this message.\n`,
        }),
      })
      if (!res.ok) throw new Error(`mail provider answered ${res.status}`)
    },
  }
}

/** Prints codes instead of mailing them, for running the issuer by hand. */
export function consoleMailer(): Mailer {
  return {
    sendCode(email, code) {
      console.log(`sign-in code for ${email}: ${code}`)
      return Promise.resolve()
    },
  }
}
