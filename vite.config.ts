import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  // host: true — so a phone on the same network can open the dev server.
  server: { host: true, port: 5173 },
  // esnext is required by top-level await in the SDK.
  build: { target: 'esnext' },
})
