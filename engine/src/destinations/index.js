import { query } from '../db/meta.js'
import { countRows, markDeleted, provisionTable, upsertRecords } from '../db/dest.js'
import * as sheets from '../sheets/writer.js'

// A destination used to mean a Postgres database, so the writer was imported
// directly wherever records were written. Sheets is a second kind with the same
// shape and completely different mechanics — no upsert, no schema, a row number
// instead of a primary key — so the choice happens once, here, and the backfill,
// webhook and reconcile paths stay identical.

const kindCache = new Map()

export async function kindOf(destinationId) {
  if (kindCache.has(destinationId)) return kindCache.get(destinationId)
  const { rows } = await query(`select kind from syncive.destinations where id = $1`, [destinationId])
  if (!rows[0]) throw new Error(`No destination ${destinationId}`)
  const kind = rows[0].kind || 'postgres'
  kindCache.set(destinationId, kind)
  return kind
}

export const forgetKind = (destinationId) => kindCache.delete(destinationId)

// Every function below takes the sync rather than just the destination: the row
// map that gives a spreadsheet its identity is per sync, and a destination can
// carry several.
export async function provision(sync, objectType, properties) {
  const kind = await kindOf(sync.destination_id)
  return kind === 'sheets'
    ? sheets.provision(sync.destination_id, objectType, properties)
    : provisionTable(sync.destination_id, objectType, properties)
}

export async function write(sync, objectType, properties, records) {
  const kind = await kindOf(sync.destination_id)
  return kind === 'sheets'
    ? sheets.upsert(sync.destination_id, objectType, properties, records, sync.id)
    : upsertRecords(sync.destination_id, objectType, properties, records)
}

export async function remove(sync, objectType, hubspotId) {
  const kind = await kindOf(sync.destination_id)
  return kind === 'sheets'
    ? sheets.markDeletedRow(sync.destination_id, objectType, hubspotId, sync.id)
    : markDeleted(sync.destination_id, objectType, hubspotId)
}

export async function total(sync, objectType) {
  const kind = await kindOf(sync.destination_id)
  return kind === 'sheets'
    ? sheets.count(sync.destination_id, objectType, sync.id)
    : countRows(sync.destination_id, objectType)
}
