import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  base: '/',
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8630',
      '/img': 'http://127.0.0.1:8630',
      '/stream': 'http://127.0.0.1:8630',
      '/web360': 'http://127.0.0.1:8630',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
