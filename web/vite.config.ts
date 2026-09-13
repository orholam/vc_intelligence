import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const apiTarget = `http://localhost:${env.APP_PORT ?? 4600}`

  return {
    plugins: [react(), tailwindcss()],
    server: {
      proxy: {
        '/openapi.json': apiTarget,
        '/v1': {
          target: apiTarget,
          configure: (proxy) => {
            // Inject the shared playground key server-side unless the caller brought their own.
            proxy.on('proxyReq', (proxyReq) => {
              if (env.PLAYGROUND_KEY && !proxyReq.getHeader('x-api-key')) {
                proxyReq.setHeader('x-api-key', env.PLAYGROUND_KEY)
              }
            })
          },
        },
      },
    },
  }
})
