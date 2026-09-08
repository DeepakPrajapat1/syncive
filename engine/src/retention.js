import { query } from './db/meta.js'

// A privacy policy that promises a retention period and a product that keeps
// everything forever is the same bug written twice. These are the numbers the
// policy states; change them here and there together, never one alone.
export const RETENTION = {
  // The dashboard shows the last five events per sync and 24-hour counters.
  // Nothing in the product reads an event older than this.
  syncEventDays: 30,
  // A delivered record's parked payload has served its purpose.
  resolvedDeadLetterDays: 30,
  // An unresolved one is a record that never reached the customer's destination,
  // so it is held long enough to be noticed and retried — but not forever.
  openDeadLetterDays: 90,
}

export async function pruneOldData() {
  const [events, resolved, open] = await Promise.all([
    query(
      `delete from syncive.sync_events
        where created_at < now() - ($1 || ' days')::interval`,
      [RETENTION.syncEventDays]
    ),
    query(
      `delete from syncive.dead_letters
        where resolved_at is not null
          and resolved_at < now() - ($1 || ' days')::interval`,
      [RETENTION.resolvedDeadLetterDays]
    ),
    query(
      `delete from syncive.dead_letters
        where resolved_at is null
          and created_at < now() - ($1 || ' days')::interval`,
      [RETENTION.openDeadLetterDays]
    ),
  ])

  const pruned = {
    syncEvents: events.rowCount,
    resolvedDeadLetters: resolved.rowCount,
    expiredDeadLetters: open.rowCount,
  }
  const total = pruned.syncEvents + pruned.resolvedDeadLetters + pruned.expiredDeadLetters
  if (total) console.log('[retention] pruned', JSON.stringify(pruned))
  return pruned
}
