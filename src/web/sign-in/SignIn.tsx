import { useEffect, type SubmitEvent } from 'react'
import { useStore } from 'zustand'
import type { SignInStore } from './store.ts'

/** The form's one field, by name. */
function field(event: SubmitEvent<HTMLFormElement>, name: string): string {
  event.preventDefault()
  const value = new FormData(event.currentTarget).get(name)
  return typeof value === 'string' ? value.trim() : ''
}

export interface SignInProps {
  store: SignInStore
  /** Whether the page's query carries an app's authorization request. */
  forApp: boolean
}

export function SignIn({ store, forApp }: SignInProps) {
  const state = useStore(store)
  const { loadSession } = state
  useEffect(() => {
    // An app that sent the browser here wants a sign-in, whoever is signed in.
    if (!forApp) void loadSession()
  }, [forApp, loadSession])

  if (state.signedInAs) {
    return forApp
      ? <p className="muted" role="status">Signed in. Returning to the app…</p>
      : (
          <>
            <h1>Signed in</h1>
            <p className="muted">You are signed in as {state.signedInAs}. Open the app you came for to continue.</p>
            {state.error && <p className="error" role="alert">{state.error}</p>}
            <button type="button" className="plain" disabled={state.busy} onClick={() => void state.signOut()}>Sign out</button>
          </>
        )
  }

  if (state.step === 'email') {
    return (
      <form onSubmit={(event) => void state.sendCode(field(event, 'email'))}>
        <h1>Sign in</h1>
        <label>
          Email
          <input name="email" type="email" autoComplete="email" defaultValue={state.email} required autoFocus />
        </label>
        {state.error && <p className="error" role="alert">{state.error}</p>}
        <button type="submit" disabled={state.busy}>Email me a code</button>
      </form>
    )
  }

  return (
    <form onSubmit={(event) => void state.verify(field(event, 'code'))}>
      <h1>Enter your code</h1>
      <p className="muted">
        If {state.email} may sign in here, a six-digit code is on its way. It is good for five minutes.
      </p>
      <label>
        Code
        <input
          name="code"
          className="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="\d{6}"
          maxLength={6}
          required
          autoFocus
        />
      </label>
      {state.error && <p className="error" role="alert">{state.error}</p>}
      <button type="submit" disabled={state.busy}>Sign in</button>
      <button type="button" className="plain" onClick={state.startOver}>Use another address</button>
    </form>
  )
}
