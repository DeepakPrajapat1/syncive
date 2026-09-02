import fs from 'node:fs'
import { pool } from './db/meta.js'

const sql = fs.readFileSync(new URL('../sql/meta.sql', import.meta.url), 'utf8')

export async function applySchema() {
  await pool.query(sql)
  console.log('[migrate] syncive schema applied')
}

// Also runnable standalone: `npm run migrate`
if (process.argv[1] && process.argv[1].endsWith('migrate.js')) {
  await applySchema()
  await pool.end()
}
import fs from 'node:fs'
import { pool } from './db/meta.js'

const sql = fs.readFileSync(new URL('../sql/meta.sql', import.meta.url), 'utf8')
await pool.query(sql)
console.log('[migrate] syncive schema applied')
await pool.end()
