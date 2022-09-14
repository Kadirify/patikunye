import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import * as schema from './schema'

export type Db = NodePgDatabase<typeof schema> & { $client: pg.Pool }

export function createDb(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString, max: 10 })
  // date sütunları JS Date'e çevrilmesin, 'YYYY-MM-DD' metni olarak kalsın
  pg.types.setTypeParser(1082, (v) => v)
  return drizzle(pool, { schema }) as Db
}

export async function runMigrations(db: Db, migrationsFolder: string) {
  await migrate(db, { migrationsFolder })
}
