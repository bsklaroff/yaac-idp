/**
 * The sign-in page's state: an address, then the code mailed to it. With an
 * app's authorization request in the page's query, a sign-in ends by leaving
 * the page for the app, so `signedInAs` is only seen without one.
 */
import { createStore } from 'zustand/vanilla'

export interface SignInApi {
  /** Each resolves to an error message, or null when it worked. */
  sendCode: (email: string) => Promise<string | null>
  verify: (email: string, code: string) => Promise<string | null>
  /** The signed-in user's email, or null. */
  session: () => Promise<string | null>
  signOut: () => Promise<string | null>
}

export interface SignInState {
  step: 'email' | 'code'
  email: string
  busy: boolean
  error: string | null
  signedInAs: string | null
  loadSession: () => Promise<void>
  sendCode: (email: string) => Promise<void>
  verify: (code: string) => Promise<void>
  startOver: () => void
  signOut: () => Promise<void>
}

export function createSignInStore(api: SignInApi) {
  return createStore<SignInState>()((set, get) => ({
    step: 'email',
    email: '',
    busy: false,
    error: null,
    signedInAs: null,
    async loadSession() {
      set({ signedInAs: await api.session() })
    },
    async sendCode(email) {
      set({ busy: true, error: null })
      const error = await api.sendCode(email)
      set(error ? { busy: false, error } : { busy: false, email, step: 'code' })
    },
    async verify(code) {
      set({ busy: true, error: null })
      const error = await api.verify(get().email, code)
      set(error ? { busy: false, error } : { busy: false, signedInAs: get().email })
    },
    startOver() {
      set({ step: 'email', error: null })
    },
    /** A sign-out that failed leaves the person shown as signed in, to try again. */
    async signOut() {
      set({ busy: true, error: null })
      const error = await api.signOut()
      set(error ? { busy: false, error } : { busy: false, signedInAs: null, step: 'email', email: '' })
    },
  }))
}

export type SignInStore = ReturnType<typeof createSignInStore>
