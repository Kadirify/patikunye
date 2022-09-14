// Arayüzü tarayıcıda geliştirmek için: veritabanı + API sabit portta (47800).
import { resolve } from 'node:path'
import { startBackend } from './main/backend'
import { FileSecretStore } from './main/secrets-file'

const dataRoot = resolve('.dev-data')
const backend = await startBackend({
  dataRoot,
  migrationsFolder: resolve('drizzle'),
  secrets: new FileSecretStore(resolve(dataRoot, 'secrets.json')),
  port: 47800,
  allowedOrigins: ['http://localhost:5173', 'http://127.0.0.1:5173'],
  log: console.log,
})

let stopping = false
async function shutdown() {
  if (stopping) return
  stopping = true
  await backend.stop()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
