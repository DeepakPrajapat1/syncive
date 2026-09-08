import { decrypt } from '../config.js'
import { query } from '../db/meta.js'
import { mappableColumns } from '../db/dest.js'
import { appendRows, columnLetter, ensureTab, readColumn, writeRanges } from './client.js'

// Row 1 is the header. Everything below it is data, and the customer is free to
// put their own columns to the right of ours — which is why we never clear the
// sheet and never reorder what is already there.
const HEADER_ROW = 1
const FIRST_DATA_ROW = 2
const FIXED = ['hs_object_id', '_synced_at', '_deleted']

const spreadsheetOf = async (destinationId) => {
  const { rows } = await query(`select config_enc from syncive.destinations where id = $1`, [
    destinationId,
  ])
  if (!rows[0]?.config_enc) throw new Error(`Destination ${destinationId} has no spreadsheet`)
  return JSON.parse(decrypt(rows[0].config_enc)).spreadsheetId
}

const tabFor = (objectType) => objectType

// The sheet's own header row is the column order — not a copy of it we keep in a
// database and hope stays in step. It survives the customer reordering nothing,
// us redeploying, and the row map being rebuilt.
async function readHeader(destinationId, spreadsheetId, tab) {
  const res = await readColumn(destinationId, spreadsheetId, `${tab}!${HEADER_ROW}:${HEADER_ROW}`)
  // majorDimension=COLUMNS on a single row gives one entry per column.
  return (res.values || []).map((col) => (col && col[0]) || '')
}

// New HubSpot properties are appended to the right of the existing header, never
// inserted. Inserting would shift every column the customer has already built
// formulas against.
async function ensureHeader(destinationId, spreadsheetId, tab, wanted) {
  const current = await readHeader(destinationId, spreadsheetId, tab)
  const missing = wanted.filter((name) => !current.includes(name))
  if (!missing.length) return current

  const header = [...current, ...missing]
  await writeRanges(destinationId, spreadsheetId, [
    {
      range: `${tab}!${columnLetter(1)}${HEADER_ROW}:${columnLetter(header.length)}${HEADER_ROW}`,
      values: [header],
    },
  ])
  return header
}

const desiredColumns = (properties) => [
  'hs_object_id',
  ...mappableColumns(properties).map((c) => c.property),
  '_synced_at',
  '_deleted',
]

// Sheets stores text; anything that is not a string becomes one. Dates go out in
// ISO so a spreadsheet can parse them and a human can read them.
function cell(value) {
  if (value === undefined || value === null) return ''
  if (value instanceof Date) return value.toISOString()
  return String(value)
}

function rowFor(header, record, properties) {
  const byProperty = new Map(mappableColumns(properties).map((c) => [c.property, c]))
  return header.map((name) => {
    if (name === 'hs_object_id') return cell(record.id)
    if (name === '_synced_at') return new Date().toISOString()
    if (name === '_deleted') return 'FALSE'
    if (!byProperty.has(name)) return '' // a column the customer added; leave it alone
    return cell(record.properties?.[name])
  })
}

export async function provision(destinationId, objectType, properties) {
  const spreadsheetId = await spreadsheetOf(destinationId)
  const tab = tabFor(objectType)
  await ensureTab(destinationId, spreadsheetId, tab)
  await ensureHeader(destinationId, spreadsheetId, tab, desiredColumns(properties))
  return `${tab}`
}

export async function upsert(destinationId, objectType, properties, records, syncId) {
  if (!records.length) return 0
  const spreadsheetId = await spreadsheetOf(destinationId)
  const tab = tabFor(objectType)
  const header = await ensureHeader(destinationId, spreadsheetId, tab, desiredColumns(properties))
  const width = columnLetter(header.length)

  const ids = records.map((r) => String(r.id))
  const { rows: known } = await query(
    `select hubspot_id, row_number from syncive.sheet_rows
      where sync_id = $1 and hubspot_id = any($2::text[])`,
    [syncId, ids]
  )
  const position = new Map(known.map((r) => [r.hubspot_id, r.row_number]))

  const updates = []
  const fresh = []
  for (const record of records) {
    const values = rowFor(header, record, properties)
    const at = position.get(String(record.id))
    if (at) updates.push({ range: `${tab}!A${at}:${width}${at}`, values: [values] })
    else fresh.push({ id: String(record.id), values })
  }

  // One batchUpdate is one request against the 60/min budget no matter how many
  // ranges it carries, so existing rows cost a single call.
  if (updates.length) await writeRanges(destinationId, spreadsheetId, updates)

  if (fresh.length) {
    const result = await appendRows(
      destinationId,
      spreadsheetId,
      `${tab}!A${FIRST_DATA_ROW}`,
      fresh.map((f) => f.values)
    )
    // Google tells us where the rows landed; that is the only reliable way to
    // learn the row numbers without reading the sheet back.
    const updated = result?.updates?.updatedRange || ''
    const startRow = Number((updated.match(/![A-Z]+(\d+)/) || [])[1])
    if (Number.isFinite(startRow)) {
      await query(
        `insert into syncive.sheet_rows (sync_id, hubspot_id, row_number)
         select $1, x.id, x.row from unnest($2::text[], $3::int[]) as x(id, row)
         on conflict (sync_id, hubspot_id) do update set row_number = excluded.row_number`,
        [syncId, fresh.map((f) => f.id), fresh.map((_, i) => startRow + i)]
      )
    }
  }

  return records.length
}

// Soft delete, same as the database destination: the row stays so a report built
// on it does not lose its shape, and a column says it is gone.
export async function markDeletedRow(destinationId, objectType, hubspotId, syncId) {
  const spreadsheetId = await spreadsheetOf(destinationId)
  const tab = tabFor(objectType)
  const { rows } = await query(
    `select row_number from syncive.sheet_rows where sync_id = $1 and hubspot_id = $2`,
    [syncId, String(hubspotId)]
  )
  if (!rows[0]) return

  const header = await readHeader(destinationId, spreadsheetId, tab)
  const at = rows[0].row_number
  const ranges = []
  const deletedAt = header.indexOf('_deleted')
  const syncedAt = header.indexOf('_synced_at')
  if (deletedAt >= 0) {
    ranges.push({ range: `${tab}!${columnLetter(deletedAt + 1)}${at}`, values: [['TRUE']] })
  }
  if (syncedAt >= 0) {
    ranges.push({
      range: `${tab}!${columnLetter(syncedAt + 1)}${at}`,
      values: [[new Date().toISOString()]],
    })
  }
  if (ranges.length) await writeRanges(destinationId, spreadsheetId, ranges)
}

export async function count(destinationId, objectType, syncId) {
  const { rows } = await query(
    `select count(*)::int as n from syncive.sheet_rows where sync_id = $1`,
    [syncId]
  )
  return rows[0].n
}
