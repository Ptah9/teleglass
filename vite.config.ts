import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * On hardware the phone cannot reach "localhost", so the HMR socket must be
 * pinned to the laptop's LAN address (docs 03-test/03-local-testing.md,
 * "HMR recovery"): `HMR_HOST=192.168.1.10 npm run dev`.
 * Empty — the simulator, which talks to localhost just fine.
 */
const hmrHost = process.env.HMR_HOST

export default defineConfig({
  plugins: [react()],
  server: {
    // host: true - so a phone on the same network can open the dev server.
    host: true,
    port: 5173,
    // The WebView's default API base is `/api`; the backend is a separate
    // process on 8787 (`app/backend`, see app/HANDOFF.md). In production the
    // base comes from VITE_API_BASE instead.
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: false,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
    ...(hmrHost ? { hmr: { host: hmrHost } } : {}),
  },
  // esnext is required by top-level await in the SDK.
  build: { target: 'esnext' },
})
