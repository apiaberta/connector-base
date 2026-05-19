/**
 * sync.js — BASE.gov.pt public contracts sync via dados.gov.pt XLSX
 *
 * Data source: dados.gov.pt dataset "Contratos Públicos - Portal Base - IMPIC"
 * (https://dados.gov.pt/datasets/contratos-publicos-base-impic/)
 *
 * Downloads yearly XLSX files, parses them, and upserts into MongoDB.
 * No API key required — dados.gov.pt is public domain (licença: other-pd).
 *
 * Yearly files: contratos2012.xlsx … contratos2026.xlsx
 * All years are downloaded and synced on each full run.
 */

import { Contract } from './models/contract.js'

// ── dados.gov.pt API ──────────────────────────────────────────────────────────

const DATASET_ID = '66d72d488ca4b7cb2de28712'

// Known years where XLSX is unavailable (404 from dados.gov.pt)
const UNAVAILABLE_YEARS = new Set([2019, 2020])

async function getResourceUrls(year) {
  if (UNAVAILABLE_YEARS.has(year)) {
    return null // Known unavailable, skip without API call
  }
  const url = `https://dados.gov.pt/api/1/datasets/${DATASET_ID}/`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`dados.gov.pt API HTTP ${res.status}`)
  const data = await res.json()
  const resources = data.resources || []

  // Find the XLSX file for the given year
  const target = resources.find(r =>
    r.format === 'xlsx' &&
    (r.title || '').includes(`${year}`)
  )
  return target?.url || null
}

async function downloadFile(url, destPath, logger) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Download HTTP ${res.status}: ${url}`)
  const buf = await res.arrayBuffer()
  const fs = await import('fs/promises')
  await fs.writeFile(destPath, Buffer.from(buf))
  logger?.info({ url, size: buf.byteLength }, 'Downloaded XLSX')
}

// ── Excel date serial → ISO string ────────────────────────────────────────────

function excelSerialToDate(serial) {
  if (!serial || serial === 'NULL' || serial === '') return null
  const n = Number(serial)
  if (isNaN(n) || n === 0) return null
  // Excel epoch is 1900-01-01 (but Excel has a leap-year bug treating 1900 as leap)
  const d = new Date(Date.UTC(1899, 11, 30 + n))
  return d.toISOString().split('T')[0]
}

// ── Column indices (0-based) in the XLSX sheet ───────────────────────────────
// Headers: ["idcontrato","nAnuncio","TipoAnuncio","idINCM","tipoContrato",
//           "idprocedimento","tipoprocedimento","objectoContrato","descContrato",
//           "adjudicante","adjudicatarios","dataPublicacao","dataCelebracaoContrato",
//           "precoContratual","CPV","prazoExecucao","LocalExecucao","fundamentacao",
//           ...]

const COL = {
  idcontrato:       0,
  objectoContrato:  7,
  descContrato:     8,
  adjudicante:      9,
  adjudicatarios:  10,
  dataPublicacao:  11,
  precoContratual: 13,
  tipoContrato:     4,
  tipoprocedimento: 6,
  LocalExecucao:   17,
  CPV:             14,
  fundamentacao:   18,
  Ano:             34,
}

function normaliseContract(row, year) {
  // Use idcontrato as primary key; fallback to nAnuncio if missing
  const id = String(row[COL.idcontrato] || row[1] || `unknown-${Date.now()}`)
  const desc1 = String(row[COL.objectoContrato] || '')
  const desc2 = String(row[COL.descContrato] || '')
  const description = desc1 || desc2

  // adjudicatarios may be multi-line (joined with \r\n)
  const awardedRaw = String(row[COL.adjudicatarios] || '').split('\r\n')[0].trim()

  // precoContratual may be a number or string like "46007" (cents?) or "1127879.04"
  let value = 0
  const priceRaw = row[COL.precoContratual]
  if (priceRaw !== undefined && priceRaw !== '' && priceRaw !== 'NULL') {
    const parsed = parseFloat(String(priceRaw).replace(',', '.').replace(/[^\d.]/g, ''))
    if (!isNaN(parsed)) {
      // If value looks like cents (< 1000 and year is recent), assume euros already
      value = parsed
    }
  }

  const date = excelSerialToDate(row[COL.dataPublicacao])

  return {
    id:                id,
    description:       description,
    contractingEntity: String(row[COL.adjudicante] || '').split('\r\n')[0].trim(),
    awarded:           awardedRaw,
    value:             value,
    date:              date,
    type:              String(row[COL.tipoprocedimento] || row[COL.tipoContrato] || 'unknown'),
    ano:               year || Number(row[COL.Ano]) || null,
    local:             String(row[COL.LocalExecucao] || ''),
    cpv:               String(row[COL.CPV] || ''),
    fundamentacao:     String(row[COL.fundamentacao] || ''),
    nAnuncio:          String(row[1] || ''),
    synced_at:         new Date(),
  }
}

// ── Sync one year XLSX ────────────────────────────────────────────────────────

async function syncYear(year, xlsxPath, logger, batchSize = 500) {
  const xlsxMod = await import('xlsx')
  const XLSX = xlsxMod.default
  const wb = XLSX.readFile(xlsxPath)
  const ws = wb.Sheets[wb.SheetNames[0]]
  const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })

  if (raw.length < 2) {
    logger?.warn({ year }, 'XLSX empty or header-only, skipping')
    return 0
  }

  const header = raw[0]
  logger?.info({ year, rows: raw.length - 1, headerLen: header.length }, 'Processing XLSX')

  // Build column index map from actual header row (case-insensitive)
  const colMap = {}
  header.forEach((h, i) => { colMap[String(h).toLowerCase()] = i })

  const getCol = (name) => colMap[name] ?? COL[name] ?? -1

  // Remap column indices based on actual header
  const actualCol = {
    idcontrato:       getCol('idcontrato'),
    objectoContrato:  getCol('objectocontarto') || getCol('objectocontato') || getCol('objectocontarto'),
    descContrato:      getCol('desccontrato'),
    adjudicante:       getCol('adjudicante'),
    adjudicatarios:    getCol('adjudicatarios'),
    dataPublicacao:    getCol('datapublicacao'),
    precoContratual:   getCol('precocontratual'),
    tipoContrato:      getCol('tipocontrato'),
    tipoprocedimento:  getCol('tipoprocedimento'),
    LocalExecucao:     getCol('localexecucao'),
    CPV:               getCol('cpv'),
    fundamentacao:     getCol('fundamentacao'),
    Ano:               getCol('ano'),
  }

  let total = 0
  const rows = raw.slice(1)

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize)
    const ops = batch.map(row => {
      // Build a "virtual row" object using actual column indices
      const virtualRow = [
        actualCol.idcontrato >= 0 ? row[actualCol.idcontrato] : '',
        actualCol.tipoprocedimento >= 0 ? row[actualCol.tipoprocedimento] : '',
        actualCol.tipoContrato >= 0 ? row[actualCol.tipoContrato] : '',
        actualCol.objectoContrato >= 0 ? row[actualCol.objectoContrato] : '',
        actualCol.descContrato >= 0 ? row[actualCol.descContrato] : '',
        actualCol.adjudicante >= 0 ? row[actualCol.adjudicante] : '',
        actualCol.adjudicatarios >= 0 ? row[actualCol.adjudicatarios] : '',
        actualCol.dataPublicacao >= 0 ? row[actualCol.dataPublicacao] : '',
        actualCol.precoContratual >= 0 ? row[actualCol.precoContratual] : '',
        actualCol.LocalExecucao >= 0 ? row[actualCol.LocalExecucao] : '',
        actualCol.CPV >= 0 ? row[actualCol.CPV] : '',
        actualCol.fundamentacao >= 0 ? row[actualCol.fundamentacao] : '',
        actualCol.Ano >= 0 ? row[actualCol.Ano] : year,
      ]

      // Override idcontrato (index 0) and adjudicante-adjudicatarios indices in virtual row
      // We'll just pass the original row and let normaliseContract use col indices
      const doc = normaliseContract(row, year)
      // Use the id from the row
      const idIdx = actualCol.idcontrato
      if (idIdx >= 0) doc.id = String(row[idIdx] || doc.id)
      const adjIdx = actualCol.adjudicante
      if (adjIdx >= 0) doc.contractingEntity = String(row[adjIdx] || '').split('\r\n')[0].trim()
      const awaIdx = actualCol.adjudicatarios
      if (awaIdx >= 0) {
        const aw = String(row[awaIdx] || '').split('\r\n')[0].trim()
        doc.awarded = aw
      }
      const objIdx = actualCol.objectoContrato
      if (objIdx >= 0) doc.description = String(row[objIdx] || '')
      const dscIdx = actualCol.descContrato
      if (dscIdx >= 0 && !doc.description) doc.description = String(row[dscIdx] || '')
      const dtIdx = actualCol.dataPublicacao
      if (dtIdx >= 0) doc.date = excelSerialToDate(row[dtIdx])
      const prcIdx = actualCol.precoContratual
      if (prcIdx >= 0) {
        const priceRaw = row[prcIdx]
        if (priceRaw !== undefined && priceRaw !== '' && priceRaw !== 'NULL') {
          const parsed = parseFloat(String(priceRaw).replace(',', '.').replace(/[^\d.]/g, ''))
          if (!isNaN(parsed)) doc.value = parsed
        }
      }
      const locIdx = actualCol.LocalExecucao
      if (locIdx >= 0) doc.local = String(row[locIdx] || '')
      const cpvIdx = actualCol.CPV
      if (cpvIdx >= 0) doc.cpv = String(row[cpvIdx] || '')
      const fundIdx = actualCol.fundamentacao
      if (fundIdx >= 0) doc.fundamentacao = String(row[fundIdx] || '')
      const tipIdx = actualCol.tipoprocedimento
      if (tipIdx >= 0) doc.type = String(row[tipIdx] || '')
      else {
        const tcIdx = actualCol.tipoContrato
        if (tcIdx >= 0) doc.type = String(row[tcIdx] || '')
      }

      return {
        updateOne: {
          filter: { id: doc.id },
          update: { $set: doc },
          upsert: true,
        }
      }
    })

    await Contract.bulkWrite(ops, { ordered: false })
    total += ops.length
    logger?.info({ year, synced: total, batch: `${i + batchSize}/${rows.length}` }, 'Batch upserted')
    // Yield event loop between batches so HTTP requests remain responsive
    await new Promise(r => setImmediate(r))
  }

  return total
}

// ── Main sync ─────────────────────────────────────────────────────────────────

/**
 * Sync contracts from dados.gov.pt XLSX files.
 *
 * @param {object} logger - Logger instance
 * @param {'incremental'|'backfill'} mode
 *   'incremental' — only current year (for cron)
 *   'backfill'   — current year + one missing historical year (for initial/background fill)
 */
export async function syncContracts(logger, mode = 'backfill') {
  const fs = await import('fs/promises')
  const os = await import('os')
  const path = await import('path')

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'base-contracts-'))

  // Determine which years to sync based on mode:
  // - cron (incremental): only current year
  // - initial/backfill (full=false): current year + one historical year to gradually fill
  // Skip years we know are unavailable (404 from dados.gov.pt)
  const currentYear = new Date().getFullYear()
  const yearsToSync = []

  if (mode === 'incremental') {
    // Cron mode: just the current year
    if (!UNAVAILABLE_YEARS.has(currentYear)) {
      yearsToSync.push(currentYear)
    }
  } else {
    // Backfill mode: current year + one most-recent missing year
    yearsToSync.push(currentYear)
    for (let y = currentYear - 1; y >= 2012; y--) {
      if (UNAVAILABLE_YEARS.has(y)) continue
      // Check if this year exists in DB already
      const existing = await Contract.countDocuments({ ano: y })
      if (existing === 0) {
        yearsToSync.push(y)
        break // only one historical year per backfill run
      }
    }
  }

  let grandTotal = 0
  let errors = []

  for (const year of yearsToSync) {
    // Yield between years so HTTP requests can be handled
    await new Promise(r => setImmediate(r))
    logger?.info({ year, mode }, 'Fetching resource URL for year')
    let xlsxUrl
    try {
      xlsxUrl = await getResourceUrls(year)
    } catch (err) {
      logger?.error({ err, year }, 'Failed to get resource URL')
      errors.push({ year, error: err.message })
      continue
    }

    if (!xlsxUrl) {
      logger?.warn({ year }, 'No XLSX resource found for year (likely unavailable), skipping')
      continue
    }

    const destPath = path.join(tmpDir, `contratos${year}.xlsx`)
    try {
      await downloadFile(xlsxUrl, destPath, logger)
      const count = await syncYear(year, destPath, logger)
      grandTotal += count
      logger?.info({ year, count }, 'Year sync complete')
    } catch (err) {
      logger?.error({ err, year }, 'Failed to sync year')
      errors.push({ year, error: err.message })
    }
  }

  // Cleanup
  await fs.rm(tmpDir, { recursive: true }).catch(() => {})

  logger?.info({ grandTotal, yearsToSync, errors }, 'Sync complete')
  return { source: 'dados.gov.pt', synced: grandTotal, years: yearsToSync, errors }
}
