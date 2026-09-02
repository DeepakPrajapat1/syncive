import { startWorkers } from './queue/jobs.js'

startWorkers().catch((err) => {
  console.error('[worker] failed to start', err)
  process.exit(1)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`[worker] ${signal} received, shutting down`)
    process.exit(0)
  })
}
