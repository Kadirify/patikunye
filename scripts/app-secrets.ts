// Kurulu uygulamanın anahtar dosyasını yalnızca bellekte çözer (Windows DPAPI + Electron safeStorage biçimi).
import { createDecipheriv } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DbSecrets, SecretStore } from '../src/main/db/supervisor'

export /** Electron safeStorage (Windows) çözümü: Local State'teki DPAPI korumalı anahtar + AES-256-GCM */
function electronSecrets(userData: string): SecretStore {
  return {
    load(): DbSecrets {
      const state = JSON.parse(readFileSync(join(userData, 'Local State'), 'utf8'))
      const wrapped = Buffer.from(state.os_crypt.encrypted_key, 'base64').subarray(5) // "DPAPI" öneki
      const ps = `Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); [Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'))`
      const key = Buffer.from(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { input: wrapped.toString('base64') }).toString().trim(), 'base64')
      const blob = readFileSync(join(userData, 'data', 'secrets.bin'))
      if (blob.subarray(0, 3).toString() !== 'v10') throw new Error('Beklenmeyen secrets.bin biçimi')
      const nonce = blob.subarray(3, 15)
      const tag = blob.subarray(blob.length - 16)
      const d = createDecipheriv('aes-256-gcm', key, nonce)
      d.setAuthTag(tag)
      const json = Buffer.concat([d.update(blob.subarray(15, blob.length - 16)), d.final()]).toString('utf8')
      return JSON.parse(json) as DbSecrets
    },
    save() {
      throw new Error('Örnek veri yükleyici anahtar dosyasını değiştirmez.')
    },
  }
}
