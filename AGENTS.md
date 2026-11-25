- Always install dependencies with exact versions: `pnpm add -E <package>` (or `pnpm add -DE <package>` for dev deps). `pnpm-workspace.yaml` refuses a release under a week old; never add a `minimumReleaseAgeExclude` entry without a comment saying why that one version cannot wait.
- **Minimize the amount of code in the codebase.** Aggressively delete code when it can go without losing functionality or making what remains substantially less clear — dead paths, one-caller wrappers, options nothing sets, compat for states nothing produces. Be on the lookout for refactors that would simplify the task at hand, and strongly consider taking them on as part of that task rather than building on top of the complication.
- **Comment style: concise, clear, and mostly in block comments.**
  - *Concise.* Say why the code is the way it is, or what a reader can't see from the code itself — not what the next line plainly does. A few sentences usually suffice; if a comment runs long, the rationale probably belongs in README.md.
  - *Clear.* Write plain English a newcomer can follow. Avoid dense jargon, coined shorthand, and LLM-speak — stacked em-dash asides, "load-bearing", "the X is the Y" aphorisms, "note that", "crucially", restating the obvious, or narrating the change you just made ("now", "no longer", "previously"). Keep comments free of history.
  - *Placed up front.* Prefer a block comment at the top of a file (what the module is for) and before a function, type, or constant (what it's for and any non-obvious contract). Keep comments out of function bodies where you can; an occasional inline comment is fine for a genuinely surprising line.
  - *Current.* A comment that no longer matches the code is worse than none — when you change code, fix or delete the comments that describe it.
- **NEVER take credit for authoring code** — do not add "Co-Authored-By" lines, or any other AI attribution to commit messages, PR descriptions, or code comments
- Limit all git commit message lines to 80 characters maximum.
- Always use `pnpm lint` for linting (runs `tsc --noEmit` for the server, the web pages and the web tests, then `eslint`).
- Running tests: pick the narrowest project (`pnpm vitest run --project server [file]`, `--project web`), and never pipe a run through `tail`/`head` — the failure details print *before* the summary, so truncating leaves you knowing only that something failed.
- Tests live in `test/server` and `test/web`. What *must* be tested is what a module hands the outside world, not every export: drive the real better-auth over an in-memory database and assert on the HTTP answers, so internals are covered incidentally. Mock at the process boundary (the mailer, `fetch`), never at a sibling module. Prefer a few rich tests over many narrow ones.
- Tests use no real timers, no wall clock and no real network. Wait on a condition (`vi.waitFor`, `findBy…`) or fake the clock instead of sleeping; bound a slow path with the test's timeout, never with `expect(elapsed).toBeLessThan(…)`, which fails on a loaded machine. An assertion on random output must not be satisfiable by chance.
- A test that takes over two seconds needs a reason a reader can see, such as a real PGlite data directory on disk, which it should keep.
- Don't let monitoring shells stack up. A backgrounded command already notifies you when it exits, so wait for that notification instead of spawning `sleep N; tail …` checks against its log.

## Layout

One package. `src/server` is the issuer's one Node process, `src/web` its two pages (sign-in and admin), and `drizzle/` the checked-in migrations. README.md is the reference for what the issuer does and how it is deployed.

- A module names another folder's by its `#server/…` or `#web/…` specifier (package.json `imports`), never by `../`. The map points at the `.ts` sources, and imports carry the `.ts` extension.
- The server runs as TypeScript on Node directly, with no build step: keep to syntax Node can strip (no enums or parameter properties). Only the pages are built, by Vite.
- `process.env` may only be read in `src/server/config.ts` (enforced by `no-process-env` on `src/**`).
- A route better-auth registers is public only if `AUTH_ROUTES` in `src/server/public-app.ts` names it. Adding one there is a security decision: say why in the change.
- The admin listener checks no identity, only that a request came from its own page at a loopback name (`ownerOnly`). Nothing on the public listener may reach its routes or call the provider plugin's client-management API.
- Admin routes are chained on one Hono app with zod-validated bodies, and the admin page calls them through `hc<AdminApp>`. Keep the chain: a route added with a separate statement is missing from the client's types.

## Database

- `src/server/db/schema.ts` uses `snakeCase.table`, which derives each column's name from its camelCase key: spell no column name out, and name a table in the plural. Its tables are better-auth's models, and `test/server/schema.test.ts` says when the two disagree.
- A schema change needs a Drizzle migration: generate it with a descriptive name via `pnpm db:generate --name <change>` (e.g. `add_passkeys`), and commit the emitted `drizzle/<timestamp>_<name>/` dir. Never keep drizzle's auto-generated random suffix (`<timestamp>_<adjective_noun>`) — if you already generated one, delete that dir and re-run with `--name`. Migrations apply in the workflow's `migrate` step (`pnpm db:migrate`), not on server start.

## Documentation

- README.md is **current-state reference**: describe how the code works *today*, in the present tense, and update it in the same change as the code it describes. Don't describe there what is not built.
- Keep it free of history: no "superseded" / "earlier scheme" / "was dropped" framing, no commit hashes, and few `file:line` citations (they drift — name the module or function instead). State the design and its rationale, and *delete* obsolete alternatives rather than narrating that they were abandoned. Keep it short — favor the "why" over enumeration.
