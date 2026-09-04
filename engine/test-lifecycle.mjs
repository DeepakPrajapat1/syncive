import assert from 'node:assert/strict'
import { parseUninstalls, UNINSTALL_TYPES } from './src/hubspot/webhooks.js'
import { RevokedError } from './src/hubspot/client.js'

// Leaving is a supported path, not an error path. These pin the parts of it that
// do not need a database.

const results = []
const check = (name, fn) => {
  try { fn(); results.push(`PASS  ${name}`) }
  catch (err) { results.push(`FAIL  ${name}\n      ${err.message}`) }
}

check('an uninstall event is recognised and its portal extracted', () => {
  const portals = parseUninstalls([
    { subscriptionType: 'app.uninstalled', portalId: 50338335 },
    { subscriptionType: 'contact.creation', portalId: 50338335, objectId: 1 },
  ])
  assert.deepEqual(portals, ['50338335'])
})

check('both names HubSpot uses for going away are handled', () => {
  for (const type of ['app.uninstalled', 'app.deauthorized']) {
    assert.ok(UNINSTALL_TYPES.has(type), type)
    assert.deepEqual(parseUninstalls([{ subscriptionType: type, portalId: 7 }]), ['7'])
  }
})

check('one portal uninstalling twice in a batch is revoked once', () => {
  const portals = parseUninstalls([
    { subscriptionType: 'app.uninstalled', portalId: 42 },
    { subscriptionType: 'app.uninstalled', portalId: 42 },
  ])
  assert.deepEqual(portals, ['42'])
})

check('ordinary record events are never mistaken for an uninstall', () => {
  assert.deepEqual(parseUninstalls([
    { subscriptionType: 'contact.deletion', portalId: 1, objectId: 9 },
    { subscriptionType: 'deal.propertyChange', portalId: 1, objectId: 9 },
  ]), [])
})

check('a revoked connection is distinguishable so callers can stop retrying', () => {
  const err = new RevokedError('HubSpot access was revoked')
  assert.equal(err.revoked, true)
  assert.ok(err instanceof Error)
})

console.log(results.join('\n'))
const failed = results.filter((r) => r.startsWith('FAIL')).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
