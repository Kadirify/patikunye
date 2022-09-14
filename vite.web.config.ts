// Arayüzü Electron olmadan tarayıcıda geliştirmek için (npm run dev:server + npm run dev:web)
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: 'src/renderer',
  resolve: { alias: { '@shared': resolve('src/shared') } },
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  define: { 'import.meta.env.VITE_API_BASE': JSON.stringify('http://127.0.0.1:47800') },
})
