import { getSheetsToken } from './oauth.js'

const API = 'https://sheets.googleapis.com/v4/spreadsheets'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Sheets allows 60 writes per minute per user and 300 per project, and answers
// 429 rather than queueing. Everything goes through one place so the backoff is
// not reinvented per call site.
async function request(destinationId, path, { method = 'GET', body, retries = 5 } = {}) {
  const { token } = await getSheetsToken(destinationId)
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })

  if (res.status === 429 || res.status === 403 || res.status >= 500) {
    const text = await res.text()
    // 403 is overloaded: a rate limit and a genuine permission failure share it.
    // Only the rate-limit shape is worth retrying.
    const rateLimited = res.status !== 403 || /rate limit|quota/i.test(text)
    if (!rateLimited) throw new Error(`Google Sheets ${res.status}: ${text}`)
    if (retries <= 0) throw new Error(`Google Sheets ${res.status} after retries: ${text}`)
    await sleep(Math.min(2 ** (5 - retries) * 1000 + Math.random() * 1000, 64_000))
    return request(destinationId, path, { method, body, retries: retries - 1 })
  }

  if (res.status === 404) {
    const err = new Error('The spreadsheet was deleted, or Syncive lost access to it')
    err.missingSheet = true
    throw err
  }
  if (!res.ok) throw new Error(`Google Sheets ${res.status} on ${path}: ${await res.text()}`)
  return res.status === 204 ? null : res.json()
}

// drive.file only covers files this app created or the customer opened through
// Google's own picker. A spreadsheet whose link they pasted is not one of those:
// the scope would look granted and every write would come back 404. Creating the
// file ourselves keeps the scope non-sensitive AND removes a step — there is no
// link to go and find.
export async function createSpreadsheet(destinationId, title) {
  const created = await request(destinationId, '', {
    method: 'POST',
    body: { properties: { title } },
  })
  return { spreadsheetId: created.spreadsheetId, url: created.spreadsheetUrl }
}

export const getSpreadsheet = (destinationId, spreadsheetId) =>
  request(destinationId, `/${spreadsheetId}?fields=properties.title,sheets.properties`)

export async function ensureTab(destinationId, spreadsheetId, title) {
  const meta = await getSpreadsheet(destinationId, spreadsheetId)
  const found = meta.sheets?.find((s) => s.properties?.title === title)
  if (found) return found.properties.sheetId

  // A brand-new spreadsheet ships with an untouched default sheet ("Sheet1").
  // Rename it for the first object rather than leaving an empty tab behind.
  const sheets = meta.sheets || []
  const leftover = sheets.length === 1 && /^Sheet1$/i.test(sheets[0].properties?.title || '')
    ? sheets[0].properties
    : null
  if (leftover) {
    await request(destinationId, `/${spreadsheetId}:batchUpdate`, {
      method: 'POST',
      body: {
        requests: [{
          updateSheetProperties: {
            properties: { sheetId: leftover.sheetId, title },
            fields: 'title',
          },
        }],
      },
    })
    return leftover.sheetId
  }

  const created = await request(destinationId, `/${spreadsheetId}:batchUpdate`, {
    method: 'POST',
    body: { requests: [{ addSheet: { properties: { title } } }] },
  })
  return created.replies[0].addSheet.properties.sheetId
}

export const readColumn = (destinationId, spreadsheetId, range) =>
  request(destinationId, `/${spreadsheetId}/values/${encodeURIComponent(range)}?majorDimension=COLUMNS`)

// RAW, always. A CRM field beginning with "=" written as USER_ENTERED becomes a
// live formula in the customer's spreadsheet — that is a text field executing as
// code, and CRM text is attacker-reachable through any web form.
export const writeRanges = (destinationId, spreadsheetId, data) =>
  request(destinationId, `/${spreadsheetId}/values:batchUpdate`, {
    method: 'POST',
    body: { valueInputOption: 'RAW', data },
  })

export const appendRows = (destinationId, spreadsheetId, range, values) =>
  request(
    destinationId,
    `/${spreadsheetId}/values/${encodeURIComponent(range)}:append` +
      `?valueInputOption=RAW&insertDataOption=INSERT_ROWS&includeValuesInResponse=false`,
    { method: 'POST', body: { values } }
  )

// A1 notation: 1 -> A, 27 -> AA. Sheets tops out at 18,278 columns and we are
// nowhere near that, but the conversion still has to be right at the boundary.
export function columnLetter(index) {
  let n = index
  let out = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    out = String.fromCharCode(65 + rem) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}
