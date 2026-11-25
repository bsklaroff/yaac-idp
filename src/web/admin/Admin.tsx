import { useEffect, type SubmitEvent } from 'react'
import { useStore } from 'zustand'
import type { AdminStore } from './store.ts'

/** Submits a form's fields to `run`, and clears the form once it worked. */
function submit(run: (fields: Record<string, string>) => Promise<boolean>) {
  return (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = event.currentTarget
    const fields = Object.fromEntries([...new FormData(form)].map(([name, value]) => [name, typeof value === 'string' ? value.trim() : '']))
    void run(fields).then((worked) => {
      if (worked) form.reset()
    })
  }
}

/**
 * What removing a user does and does not do. Each app keeps its own session,
 * and an open issuer lets anyone sign up, the removed person included.
 */
function removalNotice(email: string, openSignUp: boolean): string {
  return [
    `Remove ${email}?`,
    'They are signed out of the issuer, but each app keeps its own session for them until it ends.',
    openSignUp
      ? 'Anyone may sign up here, so they can sign in again at once, with a new id in every app.'
      : 'Adding them again gives them a new id in every app.',
  ].join(' ')
}

export function Admin({ store }: { store: AdminStore }) {
  const state = useStore(store)
  const { load } = state
  useEffect(() => {
    void load()
  }, [load])

  const { settings, created } = state
  return (
    <main className="admin">
      <header>
        <h1>Issuer admin</h1>
        {settings && (
          <p className="muted">
            <code>{settings.issuer}</code>
            {settings.openSignUp
              ? ' is open: a first sign-in creates the user.'
              : ' is closed: only the users below may sign in.'}
          </p>
        )}
        {state.error && <p className="error" role="alert">{state.error}</p>}
      </header>

      {created && settings && (
        <section className="panel" aria-label="New app">
          <h2>{created.name} is registered</h2>
          <p>Copy the secret now. It is stored hashed and cannot be shown again.</p>
          <dl className="secret">
            <dt>Issuer</dt><dd><code>{settings.issuer}</code></dd>
            <dt>Client ID</dt><dd><code>{created.clientId}</code></dd>
            <dt>Client secret</dt><dd><code>{created.clientSecret}</code></dd>
          </dl>
          <button type="button" onClick={state.dismissCreated}>Done</button>
        </section>
      )}

      <section className="panel" aria-label="Apps">
        <h2>Apps</h2>
        <ul className="rows">
          {state.apps.map((app) => (
            <li key={app.clientId}>
              <div>
                <strong>{app.name}</strong> <code>{app.clientId}</code>
                <div className="muted">{app.redirectUris.join(', ')}</div>
              </div>
              <button
                type="button"
                className="plain danger"
                aria-label={`Remove ${app.name}`}
                onClick={() => {
                  if (confirm(`Remove ${app.name}? Sign-in to it stops at once.`)) void state.deleteApp(app.clientId)
                }}
              >
                Remove
              </button>
            </li>
          ))}
          {state.apps.length === 0 && <li className="muted">No apps yet.</li>}
        </ul>
        <form onSubmit={submit(({ name = '', redirectUris = '' }) =>
          state.createApp(name, redirectUris.split(/\s+/).filter(Boolean)))}
        >
          <label>App name<input name="name" required maxLength={100} /></label>
          <label>
            Redirect URIs, one per line
            <textarea name="redirectUris" rows={2} required placeholder="https://app.example.com/auth/callback" />
          </label>
          <button type="submit">Register app</button>
        </form>
      </section>

      <section className="panel" aria-label="Users">
        <h2>Users</h2>
        <ul className="rows">
          {state.users.map((user) => (
            <li key={user.id}>
              <div>
                <strong>{user.email}</strong> {user.name}
                <div className="muted"><code>{user.id}</code></div>
              </div>
              <button
                type="button"
                className="plain"
                aria-label={`Sign out ${user.email}`}
                onClick={() => {
                  if (confirm(`Sign ${user.email} out of the issuer on every device? Each app keeps its own session for them until it ends.`)) {
                    void state.signOutUser(user.id)
                  }
                }}
              >
                Sign out
              </button>
              <button
                type="button"
                className="plain danger"
                aria-label={`Remove ${user.email}`}
                onClick={() => {
                  if (confirm(removalNotice(user.email, settings?.openSignUp ?? false))) {
                    void state.removeUser(user.id)
                  }
                }}
              >
                Remove
              </button>
            </li>
          ))}
          {state.users.length === 0 && <li className="muted">No users yet.</li>}
        </ul>
        <form onSubmit={submit(({ email = '', name = '' }) => state.addUser(email, name))}>
          <label>Email<input name="email" type="email" required /></label>
          <label>Name<input name="name" maxLength={100} /></label>
          <button type="submit">Add user</button>
        </form>
      </section>
    </main>
  )
}
