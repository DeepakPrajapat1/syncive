import './globals.css'

export const metadata = {
  title: 'Syncive — Real-time HubSpot ↔ Postgres sync',
  description:
    'Keep your HubSpot data live in your own Postgres database. Two-way sync, a health dashboard that alerts you when a record fails, and flat pricing with no per-row billing.',
  openGraph: {
    title: 'Syncive — Real-time HubSpot ↔ Postgres sync',
    description:
      'Your HubSpot data, live in your own database. Flat pricing, no per-row billing, alerts when a sync breaks.',
    type: 'website',
  },
}

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
