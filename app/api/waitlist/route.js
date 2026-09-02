export const runtime = 'edge'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

export async function POST(request) {
  let body
  try {
    body = await request.json()
  } catch {
    return json({ error: 'Invalid request.' }, 400)
  }

  const email = String(body.email || '').trim().toLowerCase()
  const company = String(body.company || '').trim().slice(0, 120)

  if (!EMAIL_RE.test(email) || email.length > 254) {
    return json({ error: 'Please enter a valid email address.' }, 400)
  }

  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_KEY

  // Not configured yet: fail loudly rather than silently dropping a signup.
  if (!url || !key) {
    return json(
      { error: 'Waitlist is not connected yet. Add SUPABASE_URL and SUPABASE_SERVICE_KEY in Vercel.' },
      503
    )
  }

  const res = await fetch(`${url}/rest/v1/waitlist`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({ email, company: company || null }),
  })

  if (res.ok) {
    return json({ message: "You're on the list. We'll email you when early access opens." })
  }

  // 23505 = unique violation -> already signed up, treat as success.
  const text = await res.text()
  if (res.status === 409 || text.includes('23505')) {
    return json({ message: "You're already on the list — we'll be in touch." })
  }

  console.error('waitlist insert failed', res.status, text)
  return json({ error: 'Could not save that right now. Please try again shortly.' }, 500)
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
