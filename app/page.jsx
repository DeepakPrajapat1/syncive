'use client'

import { useState } from 'react'

export default function Home() {
  const [email, setEmail] = useState('')
  const [company, setCompany] = useState('')
  const [state, setState] = useState({ status: 'idle', message: '' })

  async function submit(e) {
    e.preventDefault()
    if (!email.trim()) return
    setState({ status: 'loading', message: '' })
    try {
      const res = await fetch('/api/waitlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, company }),
      })
      const data = await res.json()
      if (res.ok) {
        setState({ status: 'ok', message: data.message || "You're on the list. We'll email you when early access opens." })
        setEmail(''); setCompany('')
      } else {
        setState({ status: 'err', message: data.error || 'Something went wrong. Try again in a moment.' })
      }
    } catch {
      setState({ status: 'err', message: 'Network error. Please try again.' })
    }
  }

  return (
    <>
      <div className="wrap">
        <nav className="nav">
          <a className="brand" href="/">
            <span className="mark">S</span> Syncive
          </a>
          <div className="nav-links">
            <a href="#how">How it works</a>
            <a href="#compare">Compare</a>
            <a href="#pricing">Pricing</a>
            <a href="#faq">FAQ</a>
          </div>
        </nav>

        <header className="hero">
          <div className="eyebrow"><span className="dot" /> Private beta · HubSpot ↔ Postgres</div>
          <h1>Your HubSpot data, live in your own database.</h1>
          <p className="lede">
            Real-time sync between HubSpot and Postgres, with a health dashboard that tells you
            the moment a record fails to land. Flat monthly pricing — no per-row billing, no
            invoice that grows every time your business does.
          </p>

          <form className="form" onSubmit={submit}>
            <input
              type="email" required placeholder="you@company.com" value={email}
              onChange={(e) => setEmail(e.target.value)} aria-label="Work email"
            />
            <input
              type="text" placeholder="Company (optional)" value={company}
              onChange={(e) => setCompany(e.target.value)} aria-label="Company"
            />
            <button className="btn" type="submit" disabled={state.status === 'loading'}>
              {state.status === 'loading' ? 'Joining…' : 'Join the waitlist'}
            </button>
          </form>

          {state.message && (
            <p className={`msg ${state.status === 'ok' ? 'ok' : 'err'}`}>{state.message}</p>
          )}
          <p className="form-note">
            Early access and founding-member pricing for the first 20 teams. No spam — one email when we open the beta.
          </p>
        </header>
      </div>

      <div className="wrap">
        <section id="why">
          <h2>Why we&apos;re building this</h2>
          <p className="sub">
            Every team that runs HubSpot eventually needs that data somewhere else — in the product
            database, in a real BI tool, in front of an AI agent. Getting it there is where the pain starts.
          </p>
          <div className="grid">
            <div className="card">
              <h3>Syncs fail quietly</h3>
              <p>
                Records stop flowing and nobody finds out for weeks. Webhook chains have no retry for
                deliveries you never received, and no list of what went missing.
              </p>
            </div>
            <div className="card">
              <h3>Pipelines cost engineers</h3>
              <p>
                A custom HubSpot → Postgres pipeline is weeks of work, then permanent maintenance:
                rate limits, backfills, pagination, schema drift, association handling.
              </p>
            </div>
            <div className="card">
              <h3>Bills scale with success</h3>
              <p>
                Per-active-row and per-task pricing means the invoice climbs every time your CRM
                grows. Budgeting turns into a spreadsheet exercise.
              </p>
            </div>
          </div>
        </section>

        <section id="how">
          <h2>How it works</h2>
          <p className="sub">Connect once. We handle the boring, breakable parts.</p>
          <div className="steps">
            <div className="step">
              <span className="step-n">1</span>
              <div>
                <h3>Connect HubSpot</h3>
                <p>One OAuth click. Read-only scopes to start — you approve exactly what we can see.</p>
              </div>
            </div>
            <div className="step">
              <span className="step-n">2</span>
              <div>
                <h3>Point at your Postgres</h3>
                <p>
                  Supabase, Neon, RDS or self-hosted. We create and maintain the tables, and we sync
                  from one static IP you can allowlist on your database firewall.
                </p>
              </div>
            </div>
            <div className="step">
              <span className="step-n">3</span>
              <div>
                <h3>Backfill everything</h3>
                <p>
                  Your full history, checkpointed and rate-limit aware. Watch progress live instead of
                  wondering whether it stalled.
                </p>
              </div>
            </div>
            <div className="step">
              <span className="step-n">4</span>
              <div>
                <h3>Stay live — and know it&apos;s live</h3>
                <p>
                  Webhooks land changes in seconds, and an hourly reconciliation pass catches anything
                  a webhook missed. Failures get retried, logged, and pushed to your inbox or Slack.
                </p>
              </div>
            </div>
          </div>
          <p className="foot">
            We never store your CRM data. Syncive is a pipe: records go from HubSpot straight into
            your database. We keep connection settings and sync logs — nothing else.
          </p>
        </section>

        <section id="compare">
          <h2>Where Syncive sits</h2>
          <p className="sub">
            Today you either write the pipeline yourself, accept a scheduled sync, or buy an
            enterprise contract. We think there should be something in between.
          </p>
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Option</th>
                  <th>Freshness</th>
                  <th>Entry price</th>
                  <th>Pricing model</th>
                </tr>
              </thead>
              <tbody>
                <tr className="us">
                  <td>Syncive</td>
                  <td>Real-time</td>
                  <td>$49/mo</td>
                  <td>Flat, published, no overages</td>
                </tr>
                <tr>
                  <td>StackSync</td>
                  <td>Real-time</td>
                  <td>$1,000/mo</td>
                  <td>Flat + per-record overage</td>
                </tr>
                <tr>
                  <td>Fivetran</td>
                  <td>Scheduled, one-way</td>
                  <td>Usage-based</td>
                  <td>Per monthly active row</td>
                </tr>
                <tr>
                  <td>Skyvia</td>
                  <td>Daily on entry plans</td>
                  <td>$99.79/mo</td>
                  <td>Records/month + overage</td>
                </tr>
                <tr>
                  <td>Build it yourself</td>
                  <td>However you build it</td>
                  <td>&ldquo;Free&rdquo;</td>
                  <td>Engineering weeks, forever</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="foot">Taken from each vendor&apos;s public pricing page, September 2026. Prices change — check theirs before deciding.</p>
        </section>

        <section id="pricing">
          <h2>Planned pricing</h2>
          <p className="sub">
            On the website, where pricing belongs. Outgrow a plan and we&apos;ll tell you before your
            bill does — there are no per-record overage charges.
          </p>
          <div className="plans">
            <div className="plan">
              <div className="plan-name">Free</div>
              <div className="price">$0</div>
              <ul>
                <li>1 sync</li>
                <li>10K records</li>
                <li>Daily sync</li>
                <li>Community support</li>
              </ul>
            </div>
            <div className="plan feature">
              <div className="plan-name">Growth <span className="tag">Popular</span></div>
              <div className="price">$49 <span>/mo</span></div>
              <ul>
                <li>1 database</li>
                <li>100K records</li>
                <li>Real-time sync</li>
                <li>Email failure alerts</li>
              </ul>
            </div>
            <div className="plan">
              <div className="plan-name">Scale</div>
              <div className="price">$149 <span>/mo</span></div>
              <ul>
                <li>3 syncs</li>
                <li>1M records</li>
                <li>Custom objects</li>
                <li>Slack alerts, priority support</li>
              </ul>
            </div>
            <div className="plan">
              <div className="plan-name">Agency</div>
              <div className="price">$399 <span>/mo</span></div>
              <ul>
                <li>10 client portals</li>
                <li>White-label sync reports</li>
                <li>Support SLA</li>
              </ul>
            </div>
          </div>
        </section>

        <section id="faq">
          <h2>Questions people ask first</h2>
          <div className="faq">
            <details>
              <summary>Can&apos;t I just do this with HubSpot workflows?</summary>
              <p>
                For firing a webhook at your endpoint when a deal closes — yes, and you should. A
                workflow webhook is one event at a time going one direction. It won&apos;t backfill the
                200,000 records you already have, it can&apos;t read from your database, it doesn&apos;t retry a
                delivery your server missed while it was restarting, and it won&apos;t create or migrate
                the tables on the other end. That gap is the product.
              </p>
            </details>
            <details>
              <summary>Where does my data actually live?</summary>
              <p>
                In your database. Records travel from HubSpot through our workers and into your
                Postgres. We persist connection settings, field mappings, and sync logs — never your
                contacts, companies or deals.
              </p>
            </details>
            <details>
              <summary>Which objects and databases are supported?</summary>
              <p>
                Contacts, companies and deals at launch, then tickets and custom objects. Postgres
                first — Supabase, Neon, RDS, or self-hosted — with MySQL and warehouse destinations
                after that.
              </p>
            </details>
            <details>
              <summary>How is it secured?</summary>
              <p>
                Credentials encrypted at rest, read-only HubSpot scopes to begin with, a single
                static egress IP you can allowlist, and one-click deletion of your connection and
                logs whenever you want out.
              </p>
            </details>
            <details>
              <summary>When can I use it?</summary>
              <p>
                Private beta is being built now. Waitlist members get access first, plus founding
                pricing that stays with the account.
              </p>
            </details>
          </div>
        </section>
      </div>

      <div className="wrap">
        <footer>
          <span>© {new Date().getFullYear()} Syncive</span>
          <span>Built for teams who&apos;d rather not maintain another pipeline.</span>
        </footer>
      </div>
    </>
  )
}
