import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BackendProvider } from './api/backend.js'
import { CapabilitiesProvider } from './api/capabilities.js'
import './i18n/index.js'
import { router } from './router.js'
import './styles.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
})
const rootElement = document.getElementById('root')

if (rootElement === null) {
  throw new Error('Missing #root element')
}

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BackendProvider>
        <CapabilitiesProvider>
          <RouterProvider router={router} />
        </CapabilitiesProvider>
      </BackendProvider>
    </QueryClientProvider>
  </StrictMode>,
)
