// Geliştirme ortamı için düz JSON anahtar deposu. Electron'da safeStorage kullanılır (secrets-electron.ts).
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { DbSecrets, SecretStore } from './db/supervisor'

export class FileSecretStore implements SecretStore {
  constructor(private file: string) {}
  load(): DbSecrets | null {
    return existsSync(this.file) ? (JSON.parse(readFileSync(this.file, 'utf8')) as DbSecrets) : null
  }
  save(s: DbSecrets) {
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, JSON.stringify(s, null, 2), { mode: 0o600 })
  }
}
