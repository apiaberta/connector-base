/**
 * One real call to the official BASE.gov.pt API.
 * Usage: BASE_API_KEY=… npm run check:base [-- <idContrato>]
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fetchBase } from '../src/baseClient.js'

const envPath = resolve(process.cwd(), '.env')
if (existsSync(envPath)) process.loadEnvFile(envPath)

const key = process.env.BASE_API_KEY?.trim()
if (!key) {
  console.error('ERROR: BASE_API_KEY is not set. Copy .env.example to .env and set the key from IMPIC.')
  process.exit(1)
}

const id = process.argv[2] || '1'
const url = `https://www.base.gov.pt/APIBase2/GetInfoContrato?idContrato=${encodeURIComponent(id)}`

try {
  const res = await fetchBase(url, { headers: { '_AcessToken': key } }, console)
  const body = await res.text()
  if (!res.ok) {
    console.error(`ERROR: HTTP ${res.status} from www.base.gov.pt`)
    console.error(body.slice(0, 400))
    process.exit(1)
  }
  const trimmed = body.trim()
  if (/invalid token|token is required/i.test(trimmed)) {
    console.error(`ERROR: ${trimmed}`)
    process.exit(1)
  }
  console.log(`OK: HTTP ${res.status} from www.base.gov.pt (${body.length} bytes)`)
  process.exit(0)
} catch (err) {
  console.error('ERROR:', err.cause?.code || err.code || '', err.message)
  process.exit(1)
}
