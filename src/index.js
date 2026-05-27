import Fastify from 'fastify'
import mongoose from 'mongoose'
import cron from 'node-cron'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import { baseRoutes } from './routes.js'
import { metaRoutes } from './meta.js'
import { syncContracts } from './sync.js'

const SERVICE_NAME = 'connector-base'
const PORT        = parseInt(process.env.PORT || '3003')
const MONGO_URI   = process.env.MONGO_URI || 'mongodb://localhost:27017/apiaberta-base'
const BASE_API_KEY = process.env.BASE_API_KEY

const app = Fastify({
  logger: {
    transport: process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty' }
      : undefined
  }
})

// ─── Swagger ─────────────────────────────────────────────────────────────────

await app.register(swagger, {
  openapi: {
    info: {
      title: 'API Aberta - BASE Connector',
      description: 'Portuguese public contracts from BASE.gov.pt. dados.gov.pt XLSX (public domain) for bulk data, and official API (BASE_API_KEY) for live enrichment.',
      version: '1.1.0',
    },
    servers: [{ url: `http://localhost:${PORT}` }],
    tags: [
      { name: 'Contracts', description: 'Public contracts from BASE.gov.pt' },
      { name: 'Entities', description: 'Contracting entities' },
    ],
  },
})

await app.register(swaggerUi, {
  routePrefix: '/docs',
  uiConfig: { docExpansion: 'list' },
})

app.get('/swagger', async () => app.swagger())

// ─── Health ──────────────────────────────────────────────────────────────────

app.get('/health', async () => ({
  status:    'ok',
  service:   SERVICE_NAME,
  version:   '1.0.0',
  timestamp: new Date().toISOString()
}))

// ─── Health (aliased, for gateway /v1/contracts health check) ─────────────────

app.get('/base/health', async () => ({
  status:    'ok',
  service:   SERVICE_NAME,
  version:   '1.0.0',
  timestamp: new Date().toISOString()
}))

// ─── Data routes ─────────────────────────────────────────────────────────────

await app.register(metaRoutes)
await app.register(baseRoutes, { prefix: '/base' })

// ─── Cron: sync daily at 03:00 (incremental — current year only) ───────────

cron.schedule('0 3 * * *', async () => {
  app.log.info('Cron: syncing BASE.gov.pt contracts (incremental)...')
  // Run sync in background — non-blocking, fire-and-forget
  syncContracts(app.log, 'incremental')
    .then(r => app.log.info({ r }, 'Cron contracts sync complete'))
    .catch(err => app.log.error({ err }, 'Cron contracts sync failed'))
}, { timezone: 'Europe/Lisbon' })

// ─── Startup ─────────────────────────────────────────────────────────────────

await mongoose.connect(MONGO_URI)
app.log.info('Connected to MongoDB')

// Start HTTP server FIRST so health checks are responsive immediately
await app.listen({ port: PORT, host: '0.0.0.0' })
app.log.info(`${SERVICE_NAME} listening on port ${PORT}`)

// Then sync in background — non-blocking for HTTP
// Only run initial sync if MongoDB collection is empty (first run)
const { Contract } = await import('./models/contract.js')
const count = await Contract.countDocuments()
if (count === 0) {
  app.log.info('Collection empty — running initial backfill sync...')
  syncContracts(app.log, 'backfill')
    .then(r => app.log.info({ r }, 'Initial contracts sync done'))
    .catch(err => app.log.error({ err }, 'Initial contracts sync failed'))
} else {
  app.log.info({ count }, 'Collection has data — skipping initial sync (cron at 03:00 will incrementally update)')
}
