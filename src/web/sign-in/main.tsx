import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '#web/styles.css'
import { signInApi } from './api.ts'
import { SignIn } from './SignIn.tsx'
import { createSignInStore } from './store.ts'

const store = createSignInStore(signInApi())
const query = new URLSearchParams(location.search)

/**
 * Every app skips consent, so only a request that insists on it lands on
 * the consent page. A request the issuer could not send back to its app
 * (an unknown client or redirect URI) lands here with `error`; the page
 * shows none of the query's text.
 */
const page = location.pathname === '/consent'
  ? <p role="alert">This issuer has no consent step. Return to the app and sign in again.</p>
  : query.has('error')
    ? <p role="alert">This sign-in link does not work. Return to the app and sign in again.</p>
    : <SignIn store={store} forApp={query.has('client_id')} />

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <main className="sign-in"><div className="panel">{page}</div></main>
  </StrictMode>,
)
