import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared') } },
  // Her test dosyası kendi PostgreSQL kümesini kurar; aynı anda en fazla 4
  test: { testTimeout: 20_000, hookTimeout: 120_000, maxWorkers: 4 },
})
