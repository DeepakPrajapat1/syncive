# Syncive — setup (browser only, ~15 minutes)

Nothing gets installed on your laptop. Every step below happens in a browser tab,
in your **Syncive** Chrome profile.

---

## Step 1 — Put this code in GitHub  (5 min)

1. Unzip `syncive-landing.zip` (double-click — no tools needed).
2. Open **https://github.com/synciveapps/syncive**
3. Click **Add file → Upload files**.
4. Open the unzipped folder and drag **everything inside it** (the `app` folder,
   `package.json`, `next.config.mjs`, `.gitignore`, `supabase.sql`, the two `.md` files)
   into the upload area. Do **not** drag the zip itself, and do **not** drag the outer folder.
5. Commit message: `landing page` → **Commit changes**.

> Later edits: on any file page click the pencil icon, or press `.` anywhere in the repo
> to open a full VS Code editor inside the browser.

---

## Step 2 — Deploy on Vercel  (3 min)

1. Go to **https://vercel.com/signup** → **Continue with GitHub**.
2. **Add New… → Project** → find `synciveapps/syncive` → **Import**.
3. Leave every setting as-is (it detects Next.js) → **Deploy**.
4. You get a live URL like `syncive.vercel.app`. The page works immediately —
   only the waitlist form needs Step 3.

---

## Step 3 — Waitlist storage on Supabase  (5 min)

1. Go to **https://supabase.com** → **Start your project** → **Continue with GitHub**.
2. **New project**: name `syncive`, pick a strong DB password (save it in your
   password manager), region closest to you → **Create**. Wait ~2 minutes.
3. Left sidebar → **SQL Editor** → **New query** → paste the whole contents of
   `supabase.sql` from this repo → **Run**.
4. Left sidebar → **Project Settings → API**. Copy two values:
   - **Project URL** (looks like `https://abcdefgh.supabase.co`)
   - **service_role** key (under Project API keys — click reveal)

> The `service_role` key is a full-access secret. It only ever goes into Vercel's
> environment variables (Step 4) — never into the repo, never into a chat window.

---

## Step 4 — Connect the two  (2 min)

1. In Vercel: your project → **Settings → Environment Variables**.
2. Add these two, for all environments:

   | Name | Value |
   |---|---|
   | `SUPABASE_URL` | the Project URL from Step 3 |
   | `SUPABASE_SERVICE_KEY` | the service_role key from Step 3 |

3. Go to **Deployments** → newest one → **⋯ → Redeploy**.
4. Open your live URL, enter your own email, hit **Join the waitlist**.
5. Check it landed: Supabase → **Table Editor → waitlist**. Your email should be there.

Done. You now have a live landing page collecting signups.

---

## Step 5 — Domain (whenever you're ready)

Buy `synciveapps.com` (~$11/yr), then in Vercel: **Settings → Domains → Add**,
and follow the DNS instructions it prints. Until then the `.vercel.app` URL is
perfectly fine to share.

---

## Reading your signups

Supabase → **Table Editor → waitlist**, or run in SQL Editor:

```sql
select * from waitlist_recent;
```

---

## Troubleshooting

| What you see | Fix |
|---|---|
| "Waitlist is not connected yet…" | Env vars missing or you didn't redeploy after adding them (Step 4). |
| Build fails on Vercel | You probably uploaded the outer folder. `package.json` must sit at the repo root, not inside a subfolder. |
| Email saved but form shows an error | Check the exact `service_role` key — the `anon` key won't work, RLS blocks it by design. |
