import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/capabilities': 'http://127.0.0.1:8000',
      '/health': 'http://127.0.0.1:8000',
      '/openapi.json': 'http://127.0.0.1:8000',
      '/v1': 'http://127.0.0.1:8000',
      '/version': 'http://127.0.0.1:8000',
    },
  },
})
