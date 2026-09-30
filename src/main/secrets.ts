import { app, safeStorage } from 'electron'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// The OpenRouter key never leaves the main process. It is encrypted with the OS keychain
// (Keychain on macOS, DPAPI on Windows, libsecret/kwallet on Linux) when available.

interface StoredCredentials {
  openRouterKey: string
  encrypted: boolean
}

let cachedKey: string | null | undefined

function credentialsFile(): string {
  return join(app.getPath('userData'), 'credentials.json')
}

export function getApiKey(): string | null {
  if (cachedKey !== undefined) return cachedKey
  try {
    const stored = JSON.parse(readFileSync(credentialsFile(), 'utf8')) as StoredCredentials
    cachedKey = stored.encrypted
      ? safeStorage.decryptString(Buffer.from(stored.openRouterKey, 'base64'))
      : stored.openRouterKey
  } catch {
    cachedKey = null
  }
  return cachedKey
}

export function setApiKey(key: string): void {
  const encrypted = safeStorage.isEncryptionAvailable()
  if (!encrypted) console.warn('[quick-ask] OS encryption unavailable, storing the API key unencrypted')
  const stored: StoredCredentials = {
    openRouterKey: encrypted ? safeStorage.encryptString(key).toString('base64') : key,
    encrypted
  }
  mkdirSync(dirname(credentialsFile()), { recursive: true })
  writeFileSync(credentialsFile(), JSON.stringify(stored), { mode: 0o600 })
  cachedKey = key
}

export function clearApiKey(): void {
  rmSync(credentialsFile(), { force: true })
  cachedKey = null
}

export function maskKey(key: string): string {
  return key.length <= 12 ? '••••' : `${key.slice(0, 8)}…${key.slice(-4)}`
}
