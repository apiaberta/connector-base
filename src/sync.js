/**
 * sync.js — BASE.gov.pt public contracts sync
 *
 * Data source priority:
 * 1. IMPIC official API (requires BASE_API_KEY env var — request at impic.pt)
 * 2. Legacy endpoint (deprecated, may return HTML)
 *
 * Register for API access: https://www.impic.pt/support/open.php
 * Topic: "Contratos Públicos / Pedido de acesso à API Portal Base"
 */

import { Contract } from './models/contract.js'

// IMPIC official API (used when BASE_API_KEY is set)
const IMPIC_API_URL = 'https://api.impic.pt/base/v1'
const API_KEY = process.env.BASE_API_KEY

// Legacy endpoint (deprecated)
const LEGACY_URL = 'https://www.base.gov.pt/Base4/pt/resultado'

const HEADERS = {
  'User-Agent': 'apiaberta.pt/1.0 (open-data connector)',
  'Accept': 'application/json, text/plain, */*',
}

if (API_KEY) {
  HEADERS['Authorization'] = `Bearer ${API_KEY}`
}

async function fetchFromIMPIC(logger) {
  const url = `${IMPIC_API_URL}/contratos?items=100&page=0`
  const res = await fetch(url, { headers: HEADERS })
  if (!res.ok) throw new Error(`IMPIC API HTTP ${res.status}`)
  return res.json()
}

async function fetchLegacy(page = 0) {
  const url = `${LEGACY_URL}?type=ajuste&query={}&items=25&page=${page}`
  const res = await fetch(url, { headers: HEADERS })
  if (!res.ok) throw new Error(`Legacy HTTP ${res.status}`)
  const text = await res.text()
  // Legacy endpoint may return HTML — try JSON parse, bail out if fails
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function normalise(raw, type = 'unknown') {
  return {
    id: String(raw.id || raw.nBase || raw.nIPC || `${type}-${Date.now()}-${Math.random()}`),
    description: raw.descricao || raw.description || raw.objectoContrato || raw.titulo || '',
    contractingEntity: raw.entidadeAdjudicante || raw.entidade || raw.adjudicante || '',
    awarded: raw.adjudicatario || raw.entidadeAdjudicada || raw.adjudicataria || '',
    value: parseFloat(String(raw.precoContratual || raw.valor || raw.amount || '0').replace(',', '.').replace(/[^\d.]/g, '')) || 0,
    date: raw.dataPublicacao || raw.dataPublicacaoContrato || raw.data || null,
    type: type,
    synced_at: new Date(),
  }
}

export async function syncContracts(logger) {
  let total = 0

  // ── Method 1: Official IMPIC API ──────────────────────────────────────────
  if (API_KEY) {
    logger?.info('Using official IMPIC API')
    try {
      const data = await fetchFromIMPIC(logger)
      const items = data.items || data.resultado || data.results || data.data || []

      for (const raw of items) {
        const doc = normalise(raw, raw.tipoProcedimento || 'impic')
        await Contract.findOneAndUpdate(
          { id: doc.id },
          doc,
          { upsert: true, new: true }
        )
        total++
      }

      logger?.info({ total }, 'IMPIC API sync complete')
      return { source: 'impic', synced: total }
    } catch (err) {
      logger?.error({ err }, 'IMPIC API sync failed, falling back to legacy')
    }
  }

  // ── Method 2: Legacy endpoint (deprecated) ────────────────────────────────
  logger?.warn('Legacy BASE API has no guaranteed JSON response — sync may yield 0 documents. Register for IMPIC API at https://www.impic.pt/support/open.php')

  const TYPES = ['ajuste', 'concurso']
  const PAGES_PER_SYNC = 4

  for (const type of TYPES) {
    for (let page = 0; page < PAGES_PER_SYNC; page++) {
      try {
        const data = await fetchLegacy(page)
        if (!data) {
          logger?.warn({ type, page }, 'Legacy endpoint returned HTML, skipping')
          break
        }

        const items = data.items || data.resultado || data.results || (Array.isArray(data) ? data : [])
        if (!items.length) break

        for (const raw of items) {
          const doc = normalise(raw, type)
          await Contract.findOneAndUpdate(
            { id: doc.id },
            doc,
            { upsert: true, new: true }
          )
          total++
        }

        logger?.info(`Synced ${items.length} contracts (type=${type}, page=${page})`)
        if (items.length < 25) break
      } catch (err) {
        logger?.error({ err, type, page }, 'Failed to sync BASE contracts page')
        break
      }
    }
  }

  return { source: API_KEY ? 'impic' : 'legacy', synced: total }
}
