/**
 * sync.js — BASE.gov.pt public contracts sync
 *
 * Bulk / catch-up: dados.gov.pt yearly XLSX (streaming parse).
 * Incremental: APIBase2-V2 GetInfoContrato?numDias=N (max 90) when BASE_API_KEY
 * is set. V2 has no from/to date range and no free-text search.
 *
 * Historical bug: XLSX.readFile() on the main thread blocked the event loop
 * for days. Parse is now an async stream (exceljs). Oversized files and any
 * other failure are recorded as errors — never as silent success.
 */

import { createWriteStream } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import path from 'node:path'
import { Contract } from './models/contract.js'
import { upsertOfficial } from './contractsService.js'
import { fetchOfficialContracts } from './official.js'
import { nifsFromDoc, withNifs } from './nifs.js'
import {
    daysSince,
    getSyncFreshness,
    markNifBackfillDone,
    markSyncAttempt,
    markSyncError,
    markSyncSuccess,
} from './syncState.js'
import { iterateXlsxRows } from './xlsxStream.js'

export const XLSX_MAX_SIZE = 250 * 1024 * 1024
export const V2_MAX_DAYS = 90
export const NIF_BACKFILL_BATCH = 200

const DATASET_ID = '66d72d488ca4b7cb2de28712'
const DATASET_SLUG = 'contratos-publicos-portal-base-impic-contratos-de-2012-a-2026'
const FIRST_YEAR = 2012

export function rssMB() {
    return Math.round(process.memoryUsage().rss / 1024 / 1024)
}

export function excelSerialToDate(serial) {
    if (serial == null || serial === 'NULL' || serial === '') return null
    if (serial instanceof Date && !Number.isNaN(serial.getTime())) {
        return serial.toISOString().split('T')[0]
    }
    const n = Number(serial)
    if (Number.isNaN(n) || n === 0) return null
    const d = new Date(Date.UTC(1899, 11, 30 + n))
    return d.toISOString().split('T')[0]
}

export function cellDate(value) {
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return value.toISOString().split('T')[0]
    }
    if (typeof value === 'number') return excelSerialToDate(value)
    const text = String(value ?? '').trim()
    if (!text || text.toUpperCase() === 'NULL') return null
    if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10)
    const dmy = text.match(/^(\d{2})\/(\d{2})\/(\d{4})$/)
    if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`
    const n = Number(text)
    if (!Number.isNaN(n) && n > 20_000) return excelSerialToDate(n)
    return null
}

export function mapColumns(header) {
    const colMap = {}
    header.forEach((h, i) => {
        colMap[String(h ?? '').trim().toLowerCase()] = i
    })
    const getCol = (...names) => {
        for (const name of names) {
            const idx = colMap[name.toLowerCase()]
            if (idx !== undefined) return idx
        }
        return -1
    }
    return {
        idcontrato: getCol('idcontrato'),
        nAnuncio: getCol('nanuncio'),
        objectoContrato: getCol('objectocontrato', 'objectocontarto', 'objectocontato'),
        descContrato: getCol('desccontrato'),
        adjudicante: getCol('adjudicante'),
        adjudicatarios: getCol('adjudicatarios'),
        dataPublicacao: getCol('datapublicacao'),
        dataCelebracaoContrato: getCol('datacelebracaocontrato'),
        precoContratual: getCol('precocontratual'),
        tipoContrato: getCol('tipocontrato'),
        tipoprocedimento: getCol('tipoprocedimento'),
        LocalExecucao: getCol('localexecucao'),
        CPV: getCol('cpv'),
        fundamentacao: getCol('fundamentacao'),
        Ano: getCol('ano'),
    }
}

function cell(row, idx) {
    if (idx == null || idx < 0) return ''
    return row[idx] ?? ''
}

function firstLine(value) {
    return String(value ?? '').split(/\r?\n/)[0].trim()
}

function parsePrice(raw) {
    if (raw === undefined || raw === '' || raw === 'NULL') return 0
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw
    const parsed = parseFloat(String(raw).replace(',', '.').replace(/[^\d.]/g, ''))
    return Number.isNaN(parsed) ? 0 : parsed
}

export function rowToDoc(row, year, cols) {
    const idRaw = cell(row, cols.idcontrato) || cell(row, cols.nAnuncio)
    const id = String(idRaw || '').trim()
    if (!id) return null

    const adjudicanteFull = String(cell(row, cols.adjudicante) ?? '')
    const awardedFull = String(cell(row, cols.adjudicatarios) ?? '')
    const desc1 = String(cell(row, cols.objectoContrato) || '')
    const desc2 = String(cell(row, cols.descContrato) || '')
    const date = cellDate(cell(row, cols.dataPublicacao))
        || cellDate(cell(row, cols.dataCelebracaoContrato))
    const anoRaw = cell(row, cols.Ano)
    const ano = year || Number(anoRaw) || null

    const doc = {
        id,
        description: desc1 || desc2,
        contractingEntity: firstLine(adjudicanteFull),
        awarded: firstLine(awardedFull),
        value: parsePrice(cell(row, cols.precoContratual)),
        date,
        type: String(cell(row, cols.tipoprocedimento) || cell(row, cols.tipoContrato) || 'unknown'),
        ano,
        local: String(cell(row, cols.LocalExecucao) || ''),
        cpv: String(cell(row, cols.CPV) || ''),
        fundamentacao: String(cell(row, cols.fundamentacao) || ''),
        nAnuncio: String(cell(row, cols.nAnuncio) || ''),
        synced_at: new Date(),
    }
    const nifs = nifsFromDoc({
        ...doc,
        contractingEntity: adjudicanteFull,
        awarded: awardedFull,
    })
    return { ...doc, ...nifs, nifsBackfilled: true }
}

export function formatBytesMB(bytes) {
    return +(bytes / 1024 / 1024).toFixed(1)
}

export function sizeCapError(size, year) {
    return new Error(
        `XLSX exceeds size cap (${formatBytesMB(size)} MB > ${formatBytesMB(XLSX_MAX_SIZE)} MB) for year ${year}`
    )
}

async function downloadFile(url, destPath, logger, year) {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Download HTTP ${res.status}: ${url}`)
    const declared = Number(res.headers.get('content-length') || 0)
    if (declared > XLSX_MAX_SIZE) throw sizeCapError(declared, year)

    await pipeline(Readable.fromWeb(res.body), createWriteStream(destPath))

    const fs = await import('node:fs/promises')
    const stat = await fs.stat(destPath)
    if (stat.size > XLSX_MAX_SIZE) {
        await fs.unlink(destPath).catch(() => {})
        throw sizeCapError(stat.size, year)
    }
    logger?.info({ url, size: stat.size, sizeMB: formatBytesMB(stat.size) }, 'Downloaded XLSX')
    return stat.size
}

function findYearResource(resources, year) {
    const xlsx = (resources || []).filter(r => String(r.format || '').toLowerCase() === 'xlsx')
    const exact = xlsx.find(r => String(r.title || '').toLowerCase() === `contratos${year}.xlsx`)
    if (exact) return exact
    return xlsx.find(r => (r.title || '').includes(`${year}`)) || null
}

async function fetchDatasetJson() {
    const urls = [
        `https://dados.gov.pt/api/1/datasets/${DATASET_ID}/`,
        `https://dados.gov.pt/api/1/datasets/${DATASET_SLUG}/`,
    ]
    let lastErr
    for (const url of urls) {
        try {
            const res = await fetch(url)
            if (!res.ok) {
                lastErr = new Error(`dados.gov.pt API HTTP ${res.status} (${url})`)
                continue
            }
            return await res.json()
        } catch (err) {
            lastErr = err
        }
    }
    throw lastErr || new Error('dados.gov.pt dataset lookup failed')
}

export async function getResourceUrl(year, dataset) {
    const data = dataset || await fetchDatasetJson()
    const target = findYearResource(data.resources, year)
    return target?.url || target?.latest || null
}

export async function syncYear(year, xlsxPath, logger, batchSize = 500, { Model = Contract } = {}) {
    const fs = await import('node:fs/promises')
    const stat = await fs.stat(xlsxPath).catch(() => null)
    const size = stat?.size ?? 0
    if (size === 0) {
        throw new Error(`XLSX file missing or empty for year ${year}`)
    }
    if (size > XLSX_MAX_SIZE) {
        throw sizeCapError(size, year)
    }

    logger?.info(
        { year, sizeMB: formatBytesMB(size), rssMB: rssMB() },
        'Streaming XLSX parse'
    )

    let cols = null
    let batch = []
    let total = 0
    let rowCount = 0

    const flush = async () => {
        if (!batch.length) return
        await Model.bulkWrite(batch, { ordered: false })
        total += batch.length
        batch = []
        await new Promise(resolve => setImmediate(resolve))
    }

    for await (const row of iterateXlsxRows(xlsxPath)) {
        if (!cols) {
            cols = mapColumns(row.map(h => String(h ?? '')))
            continue
        }
        rowCount += 1
        const doc = rowToDoc(row, year, cols)
        if (!doc?.id) continue
        batch.push({
            updateOne: {
                filter: { id: doc.id },
                update: { $set: doc },
                upsert: true,
            },
        })
        if (batch.length >= batchSize) {
            await flush()
            logger?.info({ year, synced: total, rssMB: rssMB() }, 'Batch upserted')
        }
    }

    await flush()

    if (rowCount === 0) {
        throw new Error(`XLSX empty or header-only for year ${year}`)
    }

    logger?.info({ year, count: total, rssMB: rssMB() }, 'Year sync complete')
    return total
}

export async function backfillNifs(logger, {
    Contract: Model = Contract,
    batchSize = NIF_BACKFILL_BATCH,
    markDone = markNifBackfillDone,
} = {}) {
    let processed = 0
    while (true) {
        const docs = await Model.find({ nifsBackfilled: { $ne: true } })
            .select('id contractingEntity awarded contractingEntities awardedEntities')
            .limit(batchSize)
            .lean()
        if (!docs.length) break
        const ops = docs.map(doc => {
            const withFields = withNifs(doc)
            return {
                updateOne: {
                    filter: { id: doc.id },
                    update: {
                        $set: {
                            contractingNifs: withFields.contractingNifs,
                            awardedNifs: withFields.awardedNifs,
                            nifsBackfilled: true,
                        },
                    },
                },
            }
        })
        await Model.bulkWrite(ops, { ordered: false })
        processed += ops.length
        logger?.info({ processed }, 'NIF backfill batch')
        await new Promise(resolve => setImmediate(resolve))
    }
    if (processed) await markDone()
    return { processed }
}

export function v2WindowDays(lastSuccess, now = Date.now()) {
    const gap = daysSince(lastSuccess, now)
    if (!Number.isFinite(gap)) return V2_MAX_DAYS
    return Math.min(V2_MAX_DAYS, Math.max(1, gap + 1))
}

export async function syncIncrementalV2(logger, {
    fetchOfficial = fetchOfficialContracts,
    now = Date.now(),
    getFreshness = getSyncFreshness,
    upsert = upsertOfficial,
} = {}) {
    if (!process.env.BASE_API_KEY?.trim()) {
        return { skipped: true, reason: 'no_api_key', synced: 0, errors: [] }
    }
    const freshness = await getFreshness()
    const days = v2WindowDays(freshness.last_success, now)
    logger?.info({ days, last_success: freshness.last_success }, 'V2 incremental GetInfoContrato numDias')
    try {
        const live = await fetchOfficial({ numDias: days }, { logger, timeout: 120_000 })
        const synced = await upsert(live.records)
        return { skipped: false, synced, errors: [], days }
    } catch (err) {
        logger?.error({ err }, 'V2 incremental sync failed')
        return {
            skipped: false,
            synced: 0,
            errors: [{ source: 'v2', error: err.message }],
            days,
        }
    }
}

async function syncXlsxYears(logger, mode) {
    const fs = await import('node:fs/promises')
    const os = await import('node:os')
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'base-contracts-'))
    const currentYear = new Date().getFullYear()
    const yearsToSync = []
    const errors = []
    let grandTotal = 0

    if (mode === 'incremental') {
        yearsToSync.push(currentYear)
    } else {
        yearsToSync.push(currentYear)
        for (let y = currentYear - 1; y >= FIRST_YEAR; y--) {
            const existing = await Contract.countDocuments({ ano: y })
            if (existing === 0) {
                yearsToSync.push(y)
                break
            }
        }
    }

    let dataset
    try {
        dataset = await fetchDatasetJson()
    } catch (err) {
        logger?.error({ err }, 'Failed to load dados.gov.pt dataset metadata')
        await fs.rm(tmpDir, { recursive: true }).catch(() => {})
        return {
            synced: 0,
            years: yearsToSync,
            errors: [{ source: 'dados.gov.pt', error: err.message }],
        }
    }

    for (const year of yearsToSync) {
        await new Promise(resolve => setImmediate(resolve))
        logger?.info({ year, mode }, 'Fetching resource URL for year')
        let xlsxUrl
        try {
            xlsxUrl = await getResourceUrl(year, dataset)
        } catch (err) {
            logger?.error({ err, year }, 'Failed to get resource URL')
            errors.push({ year, error: err.message })
            continue
        }

        if (!xlsxUrl) {
            const msg = `No XLSX resource found for year ${year}`
            logger?.error({ year }, msg)
            errors.push({ year, error: msg })
            continue
        }

        const destPath = path.join(tmpDir, `contratos${year}.xlsx`)
        try {
            await downloadFile(xlsxUrl, destPath, logger, year)
            grandTotal += await syncYear(year, destPath, logger)
        } catch (err) {
            logger?.error({ err, year }, 'Failed to sync year')
            errors.push({ year, error: err.message })
        }
    }

    await fs.rm(tmpDir, { recursive: true }).catch(() => {})
    return { synced: grandTotal, years: yearsToSync, errors }
}

function formatErrors(errors) {
    return errors.map(e => `${e.year ?? e.source}: ${e.error}`).join('; ')
}

/**
 * @param {object} logger
 * @param {'incremental'|'backfill'} mode
 */
export async function syncContracts(logger, mode = 'backfill') {
    await markSyncAttempt()
    const errors = []
    let grandTotal = 0
    const sources = []

    try {
        try {
            const backfill = await backfillNifs(logger)
            logger?.info(backfill, 'NIF backfill')
        } catch (err) {
            logger?.error({ err }, 'NIF backfill failed')
            errors.push({ source: 'nif_backfill', error: err.message })
        }

        if (mode === 'incremental') {
            const v2 = await syncIncrementalV2(logger)
            if (!v2.skipped) {
                grandTotal += v2.synced
                sources.push('v2')
                errors.push(...v2.errors)
            }
            const freshness = await getSyncFreshness()
            const gap = daysSince(freshness.last_success)
            const needXlsx = v2.skipped || v2.errors.length > 0 || gap > V2_MAX_DAYS
            if (needXlsx) {
                const xlsx = await syncXlsxYears(logger, mode)
                grandTotal += xlsx.synced
                sources.push('xlsx')
                errors.push(...xlsx.errors)
            }
        } else {
            const xlsx = await syncXlsxYears(logger, mode)
            grandTotal += xlsx.synced
            sources.push('xlsx')
            errors.push(...xlsx.errors)
        }

        if (errors.length) {
            const msg = formatErrors(errors)
            await markSyncError(msg)
            logger?.error({ grandTotal, errors, sources }, 'Sync finished with errors')
        } else {
            const extra = {}
            if (sources.includes('xlsx')) extra.last_xlsx_success = new Date()
            if (sources.includes('v2')) extra.last_v2_success = new Date()
            await markSyncSuccess(extra)
            logger?.info({ grandTotal, sources }, 'Sync complete')
        }

        return { source: sources.join('+') || 'none', synced: grandTotal, errors, sources }
    } catch (err) {
        const all = [...errors, { source: 'sync', error: err.message }]
        await markSyncError(formatErrors(all))
        logger?.error({ err, errors: all }, 'Sync failed')
        return { source: sources.join('+') || 'none', synced: grandTotal, errors: all, sources }
    }
}
