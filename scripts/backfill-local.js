/**
 * One-shot backfill of contract.local from dados.gov.pt yearly XLSX.
 *
 * Usage (on the server, next to the running connector — not at HTTP boot,
 * not from cron, not from deploy):
 *
 *   NODE_ENV=production npm run backfill:local
 *
 * Resumes from sync_state.local_backfill_year if interrupted. Safe to
 * re-run: only $set { local } where the field is missing or empty.
 * Does not build an index on local.
 *
 * Do not point MONGO_URI at production from a laptop or from `npm test`.
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import mongoose from 'mongoose'
import { backfillLocal } from '../src/sync.js'

const envPath = resolve(process.cwd(), '.env')
if (existsSync(envPath)) process.loadEnvFile(envPath)

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/apiaberta-base'

const logger = {
    info(obj, msg) {
        if (typeof obj === 'string') console.log(obj)
        else console.log(msg || 'info', obj)
    },
    warn(obj, msg) {
        if (typeof obj === 'string') console.warn(obj)
        else console.warn(msg || 'warn', obj)
    },
    error(obj, msg) {
        if (typeof obj === 'string') console.error(obj)
        else console.error(msg || 'error', obj)
    },
}

logger.info({ mongo: MONGO_URI.replace(/\/\/.*@/, '//<redacted>@') }, 'Local backfill connecting')

await mongoose.connect(MONGO_URI)
try {
    const result = await backfillLocal(logger)
    logger.info(result, 'Local backfill finished')
    if (result.errors?.length) process.exitCode = 1
} catch (err) {
    logger.error({ err }, 'Local backfill failed')
    process.exitCode = 1
} finally {
    await mongoose.disconnect().catch(() => {})
}
