import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import Fastify from 'fastify'
import mongoose from 'mongoose'
import cron from 'node-cron'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import { baseRoutes } from './routes.js'
import { metaRoutes } from './meta.js'
import { planStartupJobs, syncContracts } from './sync.js'
import { Contract, dropContractsTextIndex } from './models/contract.js'
import { getSyncFreshness } from './syncState.js'

const envPath = resolve(process.cwd(), '.env')
if (existsSync(envPath)) {
  process.loadEnvFile(envPath)
}

const SERVICE_NAME = 'connector-base'
const PORT        = parseInt(process.env.PORT || '3003')
const MONGO_URI   = process.env.MONGO_URI || 'mongodb://localhost:27017/apiaberta-base'
const BASE_API_KEY = process.env.BASE_API_KEY?.trim() || ''
const officialApiEnabled = Boolean(BASE_API_KEY)

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
      description: 'Portuguese public contracts from BASE.gov.pt. Bulk data from dados.gov.pt XLSX (public domain). Live enrichment and incremental sync via official APIBase2-V2 (BASE_API_KEY). Filter contracts by nif. The previous /APIBase2 endpoint is discontinued on 2026-12-04.',
      version: '1.4.0',
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

if (!officialApiEnabled) {
  app.log.warn(
    'BASE_API_KEY is not set. Official BASE.gov.pt API enrichment is disabled. Set BASE_API_KEY in .env (see .env.example). dados.gov.pt XLSX sync still runs.'
  )
}

cron.schedule('0 3 * * *', async () => {
  app.log.info('Cron: syncing BASE.gov.pt contracts (incremental)...')
  syncContracts(app.log, 'incremental')
    .then(r => {
      if (r.errors?.length) app.log.error({ r }, 'Cron contracts sync finished with errors')
      else app.log.info({ r }, 'Cron contracts sync complete')
    })
    .catch(err => app.log.error({ err }, 'Cron contracts sync failed'))
}, { timezone: 'Europe/Lisbon' })

// ─── Startup ─────────────────────────────────────────────────────────────────

await mongoose.connect(MONGO_URI)
app.log.info('Connected to MongoDB')

// Start HTTP server FIRST so health checks are responsive immediately
await app.listen({ port: PORT, host: '0.0.0.0' })
app.log.info(`${SERVICE_NAME} listening on port ${PORT}`)

setImmediate(() => {
  dropContractsTextIndex(Contract.collection, app.log)
    .then(r => app.log.info(r, 'Contracts text index check done'))
    .catch(err => app.log.error({ err }, 'Dropping contracts text index failed'))
})

const count = await Contract.estimatedDocumentCount()
const freshness = await getSyncFreshness()
const jobs = planStartupJobs({ count, lastSuccess: freshness.last_success })

if (jobs.sync === 'backfill') {
  app.log.info('Collection empty — running initial backfill sync...')
  syncContracts(app.log, 'backfill')
    .then(r => {
      if (r.errors?.length) app.log.error({ r }, 'Initial contracts sync finished with errors')
      else app.log.info({ r }, 'Initial contracts sync done')
    })
    .catch(err => app.log.error({ err }, 'Initial contracts sync failed'))
} else if (jobs.sync === 'incremental') {
  app.log.warn(
    { last_success: freshness.last_success, last_error: freshness.last_error },
    'Local data stale — running catch-up sync in background'
  )
  syncContracts(app.log, 'incremental')
    .then(r => {
      if (r.errors?.length) app.log.error({ r }, 'Catch-up contracts sync finished with errors')
      else app.log.info({ r }, 'Catch-up contracts sync done')
    })
    .catch(err => app.log.error({ err }, 'Catch-up contracts sync failed'))
} else {
  app.log.info({ count }, 'Collection has data — skipping initial sync (cron at 03:00 will incrementally update)')
}
