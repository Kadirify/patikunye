// Veritabanı parolaları ve şifreleme anahtarları: Windows DPAPI (Electron safeStorage) ile şifreli dosyada.
import { safeStorage } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { DbSecrets, SecretStore } from './db/supervisor'

export class ElectronSecretStore implements SecretStore {
  constructor(private file: string) {}

  async load(): Promise<DbSecrets | null> {
    if (!existsSync(this.file)) return null
    const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(await readFile(this.file))
    const secrets = JSON.parse(result) as DbSecrets
    // İşletim sistemi anahtarı döndürdüyse yeni anahtarla tekrar yaz
    if (shouldReEncrypt) await this.save(secrets)
    return secrets
  }

  async save(s: DbSecrets) {
    if (!(await safeStorage.isAsyncEncryptionAvailable())) throw new Error('İşletim sistemi şifrelemesi kullanılamıyor.')
    mkdirSync(dirname(this.file), { recursive: true })
    await writeFile(this.file, await safeStorage.encryptStringAsync(JSON.stringify(s)), { mode: 0o600 })
  }
}
