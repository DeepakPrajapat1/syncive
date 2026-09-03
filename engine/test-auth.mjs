import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { mintSession, readSessionToken } from './src/auth.js'
import { buildInstallUrl, verifyState } from './src/hubspot/oauth.js'

// The account id used to be the whole security model. These tests pin the
// properties that replaced it, so nobody quietly loosens them later.

const results = []
const check = (name, fn) => {
  try { fn(); results.push(`PASS  ${name}`) }
  catch (err) { results.push(`FAIL  ${name}\n      ${err.message}`) }
}

const ACCOUNT = crypto.randomUUID()

check('a token we minted round-trips to the same account', () => {
  assert.equal(readSessionToken(mintSession(ACCOUNT)), ACCOUNT)
})

check('a token nobody signed is rejected', () => {
  assert.equal(readSessionToken(`${ACCOUNT}.${Date.now() + 60_000}.notasignature`), null)
})

check('flipping the account id invalidates the signature', () => {
  const token = mintSession(ACCOUNT)
  const other = crypto.randomUUID()
  assert.equal(readSessionToken(token.replace(ACCOUNT, other)), null)
})

check('an expired token is rejected even though it is correctly signed', () => {
  const token = mintSession(ACCOUNT)
  const [, , sig] = token.split('.')
  assert.ok(sig)
  assert.equal(readSessionToken(`${ACCOUNT}.${Date.now() - 1000}.${sig}`), null)
})

check('garbage in, null out — never a throw', () => {
  for (const value of [undefined, null, '', '...', 'a.b', {}, 42, 'x'.repeat(5000)]) {
    assert.equal(readSessionToken(value), null, `rejected: ${String(value).slice(0, 20)}`)
  }
})

// Reinstalling is how a customer signs back in. The callback can only adopt the
// account that already owns the portal if it knows the id it was handed was one
// we invented, so that bit has to survive the round trip through HubSpot.
const stateOf = (url) => new URL(url).searchParams.get('state')

check('an invented account id comes back marked provisional', () => {
  const parsed = verifyState(stateOf(buildInstallUrl(ACCOUNT, { provisional: true })))
  assert.equal(parsed.accountId, ACCOUNT)
  assert.equal(parsed.provisional, true)
})

check('a signed-in account id does not come back provisional', () => {
  const parsed = verifyState(stateOf(buildInstallUrl(ACCOUNT)))
  assert.equal(parsed.accountId, ACCOUNT)
  assert.equal(parsed.provisional, false)
})

check('the provisional flag cannot be flipped without breaking the signature', () => {
  const state = stateOf(buildInstallUrl(ACCOUNT))
  const raw = Buffer.from(state, 'base64url').toString('utf8')
  const forged = Buffer.from(raw.replace(/\.f\./, '.p.')).toString('base64url')
  assert.throws(() => verifyState(forged), /signature/)
})

console.log(results.join('\n'))
const failed = results.filter((r) => r.startsWith('FAIL')).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
