import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '#web/styles.css'
import { Admin } from './Admin.tsx'
import { createAdminStore } from './store.ts'

createRoot(document.getElementById('root')!).render(
  <StrictMode><Admin store={createAdminStore()} /></StrictMode>,
)
