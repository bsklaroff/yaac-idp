# yaac-idp

An OpenID Connect issuer for apps hosted as [yaac](https://github.com/bsklaroff/yaac)
sites. A person signs in with a six-digit code sent to their email, and every
app registered with the issuer gets the same identity for them.

It is one Node process: [better-auth](https://better-auth.com) with its
`emailOTP`, `jwt` and OAuth provider plugins, served by Hono, over a PGlite
database (Postgres running inside the process) managed with drizzle. The
sign-in and admin pages are React with zustand, built by Vite.

The design, and the tailnet sign-in that is not built yet, are in yaac's
`docs/plans/site-identity.md`.

## Listeners

| Listener | Default port | Reached | Serves |
|---|---|---|---|
| public | 3000 | from the internet, at the issuer's hostname | the OIDC endpoints and the sign-in page |
| admin | 3001 | by the site owner's forward | registering apps, adding and removing users |

**The admin listener checks no identity.** Whoever can connect to it can
register an app and add a user. Under yaac it is the site's admin port,
which the router never serves, and it listens on 127.0.0.1 alone, so only
the owner's forward reaches it. The forward in turn admits whatever connects
to the listener it opens on the owner's machine, which yaac binds on
loopback for a site release whatever `yaac forward --bind` asks. So any
program on the owner's machine can use the admin listener, as it can the
yaac server itself, and nothing beyond the machine can.

The forward also puts the listener where any page the owner's browser has
open can send it requests, so it answers only:

- at a loopback `Host` (`localhost`, `127.0.0.1`, `[::1]` or a
  `*.localhost` name). A page that points its own hostname at 127.0.0.1
  (DNS rebinding) still names that hostname, and is refused. This stops
  browsers alone: any other client can send whatever `Host` it likes;
- to what a browser could have sent from the admin page itself, judged by
  `Origin` and `Sec-Fetch-Site`. Another page may link to it, but nothing
  more, and every CORS preflight is refused.

**The public listener serves a fixed list of routes** (`AUTH_ROUTES` in
`src/server/public-app.ts`). better-auth registers many more (account
changes, client registration), and none of them is reachable. A body sent
to any of them is cut off past 32 KiB, chunked or not, before anything reads
it. The routes
the sign-in page calls answer only that page: a call another origin's page
makes, a sibling site's included, is refused by its `Origin` or
`Sec-Fetch-Site`.

Both listeners send a Content-Security-Policy that loads only the page's
own files and lets no other site frame it, with Hono's other secure
headers.

The issuer names itself by `IDP_PUBLIC_URL` and nothing else, so no request
header changes what the discovery document says. Discovery is at
`/.well-known/openid-configuration`, and the endpoints are under `/api/auth`.

## Who may sign in

- **Closed**, the default: only users added on the admin page. A code is
  mailed to no one else, and the sign-in page answers the same either way.
- **Open** (`IDP_OPEN_SIGNUP=true`): a first sign-in creates the user.

A code is good for five minutes and three guesses. One client address may ask
for three codes a minute; the address is read from `X-Forwarded-For` when it
holds exactly one, which is what yaac's edge hands an app. One email address
is sent at most five codes an hour however many clients ask, since each code
is three more guesses at it. That holds for addresses that may not sign in
too, so it tells no one which may, and it means someone who floods a
person's address keeps them from signing in for the hour. The counts live
in fixed memory (about 2.6 MB): addresses share 65,536 slots by a keyed
hash, so a flood of other addresses can only make an address's limit
stricter, and never makes the issuer forget what it sent.

Together these allow one address 15 guesses an hour. Someone guessing
without pause for a year has about a one-in-eight chance of one landing,
while the address's owner gets five codes an hour and cannot sign in. Three
wrong guesses from anywhere also use up a pending code, so whoever knows an
address can quietly keep its owner from signing in, though it gets them in
nowhere. Filling every slot (some 330,000 requests an hour, from about 1,800
client addresses) would hold off every sign-in for the hour; browsers
already signed in carry on.

The sign-in page's answer does not wait for the mail, so how long it takes
does not turn on whether a code was mailed, and every refused code gets the
same answer. Small differences in database work remain between an address
that may sign in and one that may not; the limits above allow too few tries
at any one address to measure them. A code whose mail fails is deleted, so no one can go on
guessing a code its owner never got; a newer code mailed since is kept.
Adding or removing a user withdraws any code out for the address, so a code
issued to one account cannot sign in another at the same address.

A user's name comes from the admin page. One created by an open sign-in has
none, whatever the request said.

A user's `sub` is their row's id. Removing a user and adding them again gives
them a new one in every app. Removing a user ends their sessions here, but
an app that already signed them in keeps its own session until it asks the
issuer again. On an open issuer a removed person can sign in again at once,
as a new user. The admin page says both when removing one. To end someone's
issuer sessions and keep their account (a lost device, say), the admin page
signs them out instead.

## The issuer session

A sign-in lasts 7 days, and renews itself whenever it is used a day or more
after it last did, signing in to any app included. So a browser that signs
in to some app at least weekly stays signed in to the issuer, and through it
to every app, until it signs out (an app's sign-out, or the sign-in page's)
or its user is removed.

Over https the issuer's cookies are `__Host-` cookies, which a browser
takes only from the issuer's own host, with no `Domain`. A site on a
sibling hostname (yaac sites share their admin's domain) can set a cookie
for the whole parent domain; were the session cookie an ordinary one, such
a site could plant its own session in a visitor's browser, and every app
would then sign the visitor in as that site's owner.

## Apps

Register an app on the admin page with its name and redirect URIs. Each
redirect URI is https, with no fragment or credentials; an issuer whose own
URL is on localhost also takes `http://localhost` ones, for an app run
there too. The page shows the client secret once; it is stored hashed.
Discovery offers `client_secret_post` alone, the one method apps are
registered for. An app:

- uses the authorization code flow with PKCE (S256);
- sends its secret in the token request's form body (`client_secret_post`);
- skips the consent page, being the install's own;
- gets ID tokens signed with RS256, carrying `email`, `email_verified` and
  `name` for the `email` and `profile` scopes, and no refresh token: it
  keeps its own session and signs the person in again when that ends;
- signs out of the issuer too, by sending the browser to the discovery
  document's `end_session_endpoint` with its ID token as `id_token_hint`
  and the root of its origin as `post_logout_redirect_uri`. The issuer ends
  its session and sends the browser back there. Without that, signing in to
  any app carries on silently for as long as the issuer session lasts ("The
  issuer session"). Other apps keep their own sessions until they end.

The sign-in page carries an app's request for ten minutes; after that it
says it has expired, and the person starts again from the app. A request
the issuer cannot send back to its app (an unknown client or redirect URI)
lands on the sign-in page, which says the link does not work and shows
nothing of the request. The issuer makes one RS256 signing key when it
first signs and never rotates it.

## Logs

The issuer prints one JSON line per request on stdout (under yaac, the
`server` step's log): the time, listener, method, path, status, duration
and client address, with what the request did. A code request and a sign-in
name the email; a token answer names the user, the app and the email, one
line per sign-in to an app; an admin change names the app or user it added
or removed. No query string, body, cookie, code, token or secret is logged,
and every value is JSON-escaped and clipped, since what the internet sends
ends up in the line.

## Settings

| Variable | Default | |
|---|---|---|
| `IDP_PUBLIC_URL` | required | The issuer's URL: an origin with no path, such as `https://auth.example.com`. It must be https, except on localhost. |
| `BETTER_AUTH_SECRET` | required | At least 32 characters. Signs cookies and the sign-in page's query, and encrypts the signing keys in the database. Changing it signs everyone out and orphans the keys. |
| `IDP_DATA_DIR` | `$YAAC_VOLUME_DIR`, else `data` | Holds the database (`pg/`) and the migrate step's dump (`pre-migrate.tar.gz`). |
| `IDP_PORT` | `3000` | The public listener. |
| `IDP_ADMIN_PORT` | `3001` | The admin listener. |
| `IDP_OPEN_SIGNUP` | `false` | `true` makes the issuer open. |
| `IDP_NAME` | the URL's hostname | The name mail shows. |
| `RESEND_API_KEY` | required | The [Resend](https://resend.com) API key. |
| `IDP_MAIL_FROM` | required | The From address, on a domain verified with Resend. |
| `IDP_PRINT_CODES` | `false` | `true` prints codes to the log and mails nothing, in place of the two above. Refused unless `IDP_PUBLIC_URL` is on localhost: whoever reads the log can sign in as anyone. |

## Running as a yaac site

The issuer needs a public site (yaac `docs/public-sites.md`) with:

- **a volume**, for the database;
- **port** 3000 and **admin port** 3001;
- **a workflow** with the graph in `.yaac/site-workflow.json`, naming
  `BETTER_AUTH_SECRET` as a run secret: the issuer signs with it, so it needs
  the real value;
- **project variables** `IDP_PUBLIC_URL` and `IDP_MAIL_FROM`;
- **a project secret** `RESEND_API_KEY` holding a Resend key with **sending
  access only, restricted to the mail domain**, whose rule names
  `api.resend.com` and the path `/emails`, and that host on the project's
  allowlist. The proxy puts the key in the request, so the release never
  holds it, but it does so for every workspace of the project. A key that
  could read sent mail back would hand any of them the sign-in codes, and
  through them every app. Keep the issuer in a project of its own, and send
  from a domain used for nothing else, which bounds what a misused key can
  send. Codes are in each mail's subject and body, so whoever can read the
  Resend account's sent-mail log can read them too.

The `migrate` step waits for the volume, so it runs once no older release has
the database open. It writes a dump of the database to the volume (whole,
replacing the last one only once complete, readable by the issuer's user
alone), applies the checked-in migrations and exits before `server` starts.
The release is ready once its database answers `/ready` on the admin
listener. The dump is the only copy besides the database itself, so keep
backups of the volume elsewhere: losing it gives every user a new `sub` and
the issuer new signing keys. Only one process
may open a PGlite directory, which is why the admin routes are a listener of
the server and not a second service.

Each app's project then holds the issuer's URL and its client id as
variables, the client secret as a project secret whose rule names
`<issuer>/api/auth/oauth2/token` and the `client_secret` form field, and the
issuer's hostname on its allowlist.

Code that runs as the issuer can sign anyone in to every app behind it, so
deploy it from a commit, or from a branch only people push to.

## Developing

```sh
pnpm install
export IDP_PUBLIC_URL=http://localhost:5173 BETTER_AUTH_SECRET=$(openssl rand -hex 32) IDP_PRINT_CODES=true
pnpm db:migrate
pnpm dev        # the issuer on :3000 and :3001, restarting on change
pnpm dev:web    # Vite on :5173, proxying to both; the admin page is /admin.html
```

`pnpm dev` prints the sign-in codes. To run the built pages instead, set
`IDP_PUBLIC_URL=http://localhost:3000` and run `pnpm build && pnpm start`.

`pnpm lint` typechecks and lints; `pnpm test` runs the server and web tests.
The server runs its TypeScript directly on Node 24, so it has no build step:
keep to syntax Node can strip (no enums or parameter properties) and import
with `.ts` extensions.

Dependencies are pinned to exact versions (`pnpm add -E`), and
`pnpm-workspace.yaml` refuses any release under a week old. better-auth and
`@better-auth/oauth-provider` move together, on better-auth's security
advisories.

### Conventions

- **Imports.** A module names another folder's by its `#server/…` or
  `#web/…` specifier (package.json `imports`), never by `../`. The lint
  rules are yaac's base set.
- **Admin routes** are one chained Hono app whose JSON bodies are zod
  schemas. The admin page calls them through Hono's typed client
  (`hc<AdminApp>`), so its types are the routes' own.
- **The sign-in page** calls better-auth's routes through better-auth's
  client.

### Changing the schema

`src/server/db/schema.ts` is written by hand for the models better-auth and
its plugins define: `snakeCase.table` derives each column's name from its
camelCase key, and a table is its model's name in the plural. After
upgrading better-auth or changing its plugins, `pnpm test` names any table
or column the schema lacks or no longer needs (`schema.test.ts`). Then:

```sh
pnpm db:generate --name <what_changed>   # writes a migration under drizzle/
```

Commit the schema and the migration together.
