import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '')
  return {
    plugins: [react(), basicSsl(), tailwindcss()],
    server: {
      proxy: env.DEV_BROKER_PROXY_URL ? {
        '/ws': { target: env.DEV_BROKER_PROXY_URL, ws: true, rewriteWsOrigin: true },
      } : undefined,
    },
  }
})
