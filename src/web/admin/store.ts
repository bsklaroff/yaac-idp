/**
 * The admin page's state: the issuer's apps and users, read and changed
 * through the admin listener's routes. The client is typed from the routes
 * themselves, so a route that changes shape fails this file's typecheck.
 */
import { hc, type InferResponseType } from 'hono/client'
import { createStore } from 'zustand/vanilla'
import type { AdminApp } from '#server/admin-app.ts'

type Api = ReturnType<typeof hc<AdminApp>>['api']
export type Settings = InferResponseType<Api['settings']['$get']>
export type App = InferResponseType<Api['apps']['$get']>[number]
export type NewApp = InferResponseType<Api['apps']['$post'], 201>
export type User = InferResponseType<Api['users']['$get']>[number]

export interface AdminState {
  settings: Settings | null
  apps: App[]
  users: User[]
  /** The app just registered. Its secret is shown this once. */
  created: NewApp | null
  error: string | null
  load: () => Promise<void>
  createApp: (name: string, redirectUris: string[]) => Promise<boolean>
  deleteApp: (clientId: string) => Promise<void>
  addUser: (email: string, name: string) => Promise<boolean>
  removeUser: (id: string) => Promise<void>
  /** Ends the user's issuer sessions, keeping their account. */
  signOutUser: (id: string) => Promise<void>
  dismissCreated: () => void
}

/** Throws what a refusal said. Every refusal's body is `{ error }`. */
async function refuse(res: Response): Promise<never> {
  const answer = await res.json().catch(() => null) as { error?: string } | null
  throw new Error(answer?.error ?? `The issuer answered ${res.status}.`)
}

export function createAdminStore(fetchFn: typeof fetch = fetch) {
  const { api } = hc<AdminApp>(location.origin, { fetch: fetchFn })

  return createStore<AdminState>()((set, get) => {
    /** Runs a change, then reads the lists again. Resolves to whether it worked. */
    async function change(run: () => Promise<Response>): Promise<boolean> {
      try {
        set({ error: null })
        const res = await run()
        if (!res.ok) await refuse(res)
        await get().load()
        return true
      } catch (error) {
        set({ error: error instanceof Error ? error.message : String(error) })
        return false
      }
    }
    return {
      settings: null,
      apps: [],
      users: [],
      created: null,
      error: null,
      async load() {
        const [settings, apps, users] = await Promise.all([api.settings.$get(), api.apps.$get(), api.users.$get()])
        set({ settings: await settings.json(), apps: await apps.json(), users: await users.json() })
      },
      createApp: (name, redirectUris) => change(async () => {
        const res = await api.apps.$post({ json: { name, redirectUris } })
        if (res.status === 201) set({ created: await res.json() })
        return res
      }),
      async deleteApp(clientId) {
        await change(() => api.apps[':clientId'].$delete({ param: { clientId } }))
      },
      addUser: (email, name) => change(() => api.users.$post({ json: { email, name } })),
      async signOutUser(id) {
        await change(() => api.users[':id']['sign-out'].$post({ param: { id } }))
      },
      async removeUser(id) {
        await change(() => api.users[':id'].$delete({ param: { id } }))
      },
      dismissCreated() {
        set({ created: null })
      },
    }
  })
}

export type AdminStore = ReturnType<typeof createAdminStore>
