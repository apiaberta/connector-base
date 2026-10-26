/**
 * HTTPS client for www.base.gov.pt.
 *
 * The server sends an incomplete TLS chain (leaf only). Requests use an
 * https.Agent with system roots (tls.rootCertificates) plus the bundled
 * Sectigo intermediate. Scoped to *.base.gov.pt — never disables verification.
 *
 * If a chain error still occurs, the leaf AIA "CA Issuers" URL is fetched
 * at runtime (DER→PEM), cached, and the request is retried once.
 */

import { X509Certificate } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import https from 'node:https'
import { dirname, resolve } from 'node:path'
import tls from 'node:tls'
import { fileURLToPath } from 'node:url'

const CERTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../certs')
export const BUNDLED_INTERMEDIATE_PATH = resolve(CERTS_DIR, 'base-gov-intermediate.pem')
const RUNTIME_CACHE_PATH = resolve(CERTS_DIR, 'base-gov-intermediate.runtime.pem')

const CHAIN_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
])

function readPem(path) {
  try {
    if (existsSync(path)) return readFileSync(path, 'utf8')
  } catch { /* optional */ }
  return null
}

const extraCas = []
const bundled = readPem(BUNDLED_INTERMEDIATE_PATH)
if (bundled) extraCas.push(bundled)
const cachedOnDisk = readPem(RUNTIME_CACHE_PATH)
if (cachedOnDisk && cachedOnDisk !== bundled) extraCas.push(cachedOnDisk)

let runtimePem = null
let agent = createAgent()

function createAgent() {
  const ca = [...tls.rootCertificates, ...extraCas]
  if (runtimePem && !ca.includes(runtimePem)) ca.push(runtimePem)
  return new https.Agent({ ca, keepAlive: true })
}

export function isBaseGovHost(hostname) {
  return hostname === 'base.gov.pt' || hostname.endsWith('.base.gov.pt')
}

function isChainError(err) {
  for (let e = err; e; e = e.cause) {
    if (CHAIN_CODES.has(e.code)) return true
  }
  return false
}

function requestOnce(url, options = {}) {
  const u = new URL(url)
  if (!isBaseGovHost(u.hostname)) {
    return Promise.reject(new Error(`fetchBase is scoped to base.gov.pt, got ${u.hostname}`))
  }

  const method = options.method || 'GET'
  const headers = { 'User-Agent': 'apiaberta-base/1.1', ...options.headers }

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method,
      headers,
      agent,
      servername: u.hostname,
    }, (res) => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const body = Buffer.concat(chunks)
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          headers: res.headers,
          async text() { return body.toString('utf8') },
          async json() { return JSON.parse(body.toString('utf8')) },
        })
      })
    })
    req.on('error', reject)
    if (options.body) req.write(options.body)
    req.end()
  })
}

export function parseCaIssuersUrls(infoAccess) {
  if (!infoAccess) return []
  const urls = []
  for (const line of String(infoAccess).split(/\r?\n/)) {
    const m = line.match(/CA\s*Issuers\s*-\s*URI:(https?:\/\/\S+)/i)
    if (m) urls.push(m[1].replace(/[,;]+$/, ''))
  }
  return urls
}

function inspectLeafCertificate(hostname) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: hostname,
      port: 443,
      servername: hostname,
      // Inspect the leaf AIA only. API traffic always uses a verifying agent.
      rejectUnauthorized: false,
    }, () => {
      try {
        const cert = socket.getPeerX509Certificate()
        socket.end()
        resolve(cert)
      } catch (err) {
        socket.destroy()
        reject(err)
      }
    })
    socket.setTimeout(10000, () => {
      socket.destroy()
      reject(new Error(`TLS inspect timeout for ${hostname}`))
    })
    socket.on('error', reject)
  })
}

async function fetchAiaPem(aiaUrl) {
  const res = await fetch(aiaUrl)
  if (!res.ok) throw new Error(`AIA download HTTP ${res.status}: ${aiaUrl}`)
  const buf = Buffer.from(await res.arrayBuffer())
  return new X509Certificate(buf).toString()
}

async function recoverIntermediate(hostname, logger) {
  if (runtimePem) return runtimePem
  const leaf = await inspectLeafCertificate(hostname)
  const urls = parseCaIssuersUrls(leaf.infoAccess)
  if (!urls.length) throw new Error('Leaf certificate has no AIA CA Issuers URL')
  logger?.warn({ hostname, aia: urls[0] }, 'Fetching missing BASE.gov.pt intermediate from AIA CA Issuers')
  const pem = await fetchAiaPem(urls[0])
  runtimePem = pem
  agent = createAgent()
  try {
    writeFileSync(RUNTIME_CACHE_PATH, pem)
  } catch { /* disk cache is optional */ }
  logger?.info({ hostname }, 'Cached BASE.gov.pt intermediate from AIA; retrying once')
  return pem
}

export async function fetchBase(url, options = {}, logger) {
  try {
    return await requestOnce(url, options)
  } catch (err) {
    if (!isChainError(err)) throw err
    logger?.warn({ err, url }, 'BASE.gov.pt TLS chain error; recovering intermediate via AIA')
    await recoverIntermediate(new URL(url).hostname, logger)
    return await requestOnce(url, options)
  }
}
