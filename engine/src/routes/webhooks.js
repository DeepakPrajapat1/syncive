import express from 'express'
import { dedupe, parseEvents, parseUninstalls, revokePortal, verifySignature } from '../hubspot/webhooks.js'
import { enqueueWebhookEvents } from '../queue/jobs.js'
import { config } from '../config.js'

export const webhookRouter = express.Router()

// Raw body: the signature is computed over the exact bytes HubSpot sent.
webhookRouter.post('/hubspot', express.raw({ type: '*/*', limit: '2mb' }), async (req, res) => {
  const body = req.body.toString('utf8')
  const ok = verifySignature({
    signature: req.get('x-hubspot-signature-v3'),
    timestamp: req.get('x-hubspot-request-timestamp'),
    method: 'POST',
    uri: `${config.publicUrl}/webhooks/hubspot`,
    body,
  })
  if (!ok) return res.status(401).json({ error: 'bad signature' })

  // Acknowledge fast, work later. HubSpot retries anything slower than ~5s,
  // and a slow 200 is how you turn one event into five.
  res.status(200).json({ received: true })

  try {
    const payload = JSON.parse(body)

    // Handle the leaving customer before the record changes: whatever else is in
    // this batch, their access is already gone.
    for (const portalId of parseUninstalls(payload)) {
      await revokePortal(portalId, 'The app was uninstalled in HubSpot')
    }

    const events = dedupe(parseEvents(payload))
    if (events.length) await enqueueWebhookEvents(events)
  } catch (err) {
    console.error('[webhook] enqueue failed', err.message)
  }
})
