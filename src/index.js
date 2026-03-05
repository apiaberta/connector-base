import Fastify from 'fastify'
import mongoose from 'mongoose'
import cron from 'node-cron'
import { baseRoutes } from './routes.js'
import { syncContracts } from './sync.js'

const SERVICE_NAME = 'connector-base'
const PORT      = parseInt(process.env.PORT || '3003')
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/apiaberta-base'

const app = Fastify({
  logger: {
    transport: process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty' }
      : undefined
  }
})

// ─── Health ──────────────────────────────────────────────────────────────────

app.get('/health', async () => ({
  status:    'ok',
  service:   SERVICE_NAME,
  version:   '1.0.0',
  timestamp: new Date().toISOString()
}))

// ─── Data routes ─────────────────────────────────────────────────────────────

await app.register(baseRoutes, { prefix: '/base' })

// ─── Cron: sync daily at 03:00 ───────────────────────────────────────────────

cron.schedule('0 3 * * *', async () => {
  app.log.info('Cron: syncing BASE.gov.pt contracts...')
  try {
    const r = await syncContracts(app.log)
    app.log.info({ r }, 'Contracts sync complete')
  } catch (err) {
    app.log.error({ err }, 'Contracts sync failed')
  }
}, { timezone: 'Europe/Lisbon' })

// ─── Startup ─────────────────────────────────────────────────────────────────

await mongoose.connect(MONGO_URI)
app.log.info('Connected to MongoDB')

// Initial sync on startup
app.log.info('Running initial BASE contracts sync...')
syncContracts(app.log)
  .then(r => app.log.info({ r }, 'Initial contracts sync done'))
  .catch(err => app.log.error({ err }, 'Initial contracts sync failed'))

await app.listen({ port: PORT, host: '0.0.0.0' })
app.log.info(`${SERVICE_NAME} listening on port ${PORT}`)
