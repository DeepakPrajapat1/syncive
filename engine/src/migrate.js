import fs from 'node:fs'
import { pool } from './db/meta.js'

const sql = fs.readFileSync(new URL('../sql/meta.sql', import.meta.url), 'utf8')

// Boot happens while the previous instance is still serving traffic, so for a
// few seconds two processes share one connection budget and the new one can be
// refused outright. Crashing there fails the whole deploy over a condition that
// resolves itself, so transient connection errors get a few backed-off retries.
const TRANSIENT = /EMAXCONNSESSION|too many clients|Connection terminated|ECONNRESET|ETIMEDOUT|timeout expired/i

export async function applySchema({ attempts = 6 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query(sql)
      console.log('[migrate] syncive schema applied')
      return
    } catch (err) {
      if (attempt >= attempts || !TRANSIENT.test(err.message)) throw err
      const waitMs = Math.min(1000 * 2 ** (attempt - 1), 15_000)
      console.warn(`[migrate] ${err.message} — retrying in ${waitMs}ms (${attempt}/${attempts - 1})`)
      await new Promise((r) => setTimeout(r, waitMs))
    }
  }
}

// Also runnable standalone: `npm run migrate`
if (process.argv[1] && process.argv[1].endsWith('migrate.js')) {
  await applySchema()
  await pool.end()
}
