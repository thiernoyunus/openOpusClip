import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const backendTarget = env.VITE_PROXY_BACKEND || 'http://localhost:8000'
  const rendererTarget = env.VITE_PROXY_RENDERER || 'http://localhost:3100'

  return {
    plugins: [react()],
    server: {
      // Honor a harness/host-assigned port (e.g. preview tooling) when PORT is
      // set; otherwise fall back to Vite's default (5173).
      port: process.env.PORT ? Number(process.env.PORT) : undefined,
      allowedHosts: [
        'openshorts.app',
        'www.openshorts.app'
      ],
      proxy: {
        '/api': {
          target: backendTarget,
          changeOrigin: true,
        },
        '/videos': {
          target: backendTarget,
          changeOrigin: true,
        },
        '/thumbnails': {
          target: backendTarget,
          changeOrigin: true,
        },
        '/gallery': {
          target: backendTarget,
          changeOrigin: true,
        },
        '/video': {
          target: backendTarget,
          changeOrigin: true,
        },
        '/render': {
          target: rendererTarget,
          changeOrigin: true,
        }
      }
    }
  }
})
