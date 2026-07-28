import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const apiTarget = process.env.DATABENCH_DEV_API_ORIGIN ?? 'http://127.0.0.1:8000'

export default defineConfig({
  build: {
    manifest: true,
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/capabilities': apiTarget,
      '/evalscope-api': apiTarget,
      '/health': apiTarget,
      '/openapi.json': apiTarget,
      '/swift-studio': {
        target: apiTarget,
        ws: true,
      },
      '/swift-studio-runtime': apiTarget,
      '/v2': apiTarget,
      '/version': apiTarget,
    },
  },
})
