import fs from 'node:fs'
import { pool } from './db/meta.js'

const sql = fs.readFileSync(new URL('../sql/meta.sql', import.meta.url), 'utf8')
await pool.query(sql)
console.log('[migrate] syncive schema applied')
await pool.end()
