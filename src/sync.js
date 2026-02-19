/**
 * sync.js — BASE.gov.pt public contracts sync
 * Fetches recent contracts daily and stores in MongoDB.
 */

import { Contract } from './models/contract.js'

const BASE_URL = 'https://www.base.gov.pt/Base4/pt/resultado/'
const HEADERS  = {
  'User-Agent': 'apiaberta.pt/1.0 (open-data connector)',
  'Accept': 'application/json, text/plain, */*',
  'Referer': 'https://www.base.gov.pt/Base4/pt/pesquisa/?tipo=ajuste'
}

const CONTRACT_TYPES = ['ajuste', 'concurso']
const PAGES_PER_SYNC = 4 // fetch 4 pages (100 contracts) per type per sync

async function fetchPage(type, page = 0, items = 25) {
  const url = `${BASE_URL}?type=${type}&query={}&items=${items}&page=${page}`
  const res = await fetch(url, { headers: HEADERS })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return res.json()
}

function normalise(raw, type) {
  return {
    id:                 String(raw.id || raw.nBase || `${type}-${Date.now()}-${Math.random()}`),
    description:        raw.descricao || raw.description || raw.objectoContrato || '',
    contractingEntity:  raw.entidadeAdjudicante || raw.entidade || '',
    awarded:            raw.adjudicatario || raw.entidadeAdjudicada || '',
    value:              parseFloat(String(raw.precoContratual || raw.valor || '0').replace(',', '.').replace(/[^\d.]/g, '')) || 0,
    date:               raw.dataPublicacao || raw.data || null,
    type:               type,
    synced_at:          new Date()
  }
}

export async function syncContracts(logger) {
  let total = 0
  const errors = []

  for (const type of CONTRACT_TYPES) {
    for (let page = 0; page < PAGES_PER_SYNC; page++) {
      try {
        const data = await fetchPage(type, page)
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
        errors.push({ type, page, error: err.message })
        break // stop paging on error
      }
    }
  }

  return { synced: total, errors }
}
