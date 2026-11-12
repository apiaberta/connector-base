import { Contract as ContractModel } from './models/contract.js'
import { fetchOfficialContracts, hasOfficialApiKey } from './official.js'
import { toCacheDocument } from './baseApi.js'
import { invalidNifError, normalizeNif } from './nifs.js'
import { getSyncFreshness, isStale } from './syncState.js'
import {
    LIST_PROJECTION,
    QUERY_MAX_TIME_MS,
    SEARCH_MAX_TIME_MS,
    UPSERT_BATCH_SIZE,
    clampPageLimit,
    isMaxTimeError,
    isUnfilteredQuery,
    searchDateRange,
    yearDateRange,
    yieldToEventLoop,
} from './queryLimits.js'

export const LIVE_TIMEOUT_MS = 20_000
const LIVE_WARNING = 'Official BASE API unavailable; returning local cache'
const SEARCH_TIMEOUT_WARNING = 'Search timed out; narrow from/to or q'

export function toListItem(contract) {
    return {
        id: contract.id,
        description: contract.description,
        contractingEntity: contract.contractingEntity,
        awarded: contract.awarded,
        value: contract.value,
        date: contract.date,
        type: contract.type,
        synced_at: contract.synced_at,
    }
}

export function nifClause(nif) {
    return { $or: [{ contractingNifs: nif }, { awardedNifs: nif }] }
}

export function buildListQuery({ type, year, nif } = {}) {
    const parts = []
    if (type) parts.push({ type })
    const yearRange = yearDateRange(year)
    if (yearRange) parts.push({ date: yearRange })
    if (nif) parts.push(nifClause(nif))
    if (parts.length === 0) return {}
    if (parts.length === 1) return parts[0]
    return { $and: parts }
}

export function shouldFetchLive({ nif, localCount, lastSuccess, hasKey }) {
    if (!hasKey || !nif) return false
    if (!localCount) return true
    return isStale(lastSuccess)
}

export async function upsertOfficial(records, Contract = ContractModel, { batchSize = UPSERT_BATCH_SIZE } = {}) {
    if (!records?.length) return 0
    const size = Math.max(1, batchSize)
    let n = 0
    for (let i = 0; i < records.length; i += size) {
        const docs = records.slice(i, i + size).map(mapped => toCacheDocument(mapped)).filter(Boolean)
        if (!docs.length) continue
        await Contract.bulkWrite(
            docs.map(doc => ({
                updateOne: {
                    filter: { id: doc.id },
                    update: { $set: doc },
                    upsert: true,
                },
            })),
            { ordered: false }
        )
        n += docs.length
        await yieldToEventLoop()
    }
    return n
}

function withMaxTime(cursor, maxTimeMS) {
    if (maxTimeMS && typeof cursor.maxTimeMS === 'function') {
        return cursor.maxTimeMS(maxTimeMS)
    }
    return cursor
}

async function runFind(Contract, query, { skip, limit, sort, projection, maxTimeMS = QUERY_MAX_TIME_MS } = {}) {
    let cursor = projection
        ? Contract.find(query, projection)
        : Contract.find(query)
    if (sort) cursor = cursor.sort(sort)
    if (skip) cursor = cursor.skip(skip)
    if (limit) cursor = cursor.limit(limit)
    cursor = withMaxTime(cursor, maxTimeMS)
    return cursor.lean()
}

export async function countContracts(Contract, query, { maxTimeMS = QUERY_MAX_TIME_MS } = {}) {
    if (isUnfilteredQuery(query) && typeof Contract.estimatedDocumentCount === 'function') {
        return Contract.estimatedDocumentCount()
    }
    const cursor = Contract.countDocuments(query)
    return withMaxTime(cursor, maxTimeMS)
}

async function liveNifLookup({
    nif,
    year,
    logger,
    fetchOfficial,
    Contract,
}) {
    const params = { nifEntidade: nif }
    if (year) params.ano = year
    const live = await fetchOfficial(params, { logger, timeout: LIVE_TIMEOUT_MS })
    if (live.disabled) return { source: 'local', warning: undefined }
    await upsertOfficial(live.records, Contract)
    return { source: 'live', warning: undefined }
}

async function maybeLiveFallback({
    nif,
    year,
    localCount,
    logger,
    Contract,
    fetchOfficial,
    getFreshness,
}) {
    const hasKey = hasOfficialApiKey()
    const freshness = await getFreshness()
    if (!shouldFetchLive({
        nif,
        localCount,
        lastSuccess: freshness.last_success,
        hasKey,
    })) {
        return { source: 'local' }
    }
    try {
        return await liveNifLookup({ nif, year, logger, fetchOfficial, Contract })
    } catch (err) {
        logger?.warn({ err, nif }, 'BASE V2 live fallback failed; returning local cache')
        return { source: 'local', warning: LIVE_WARNING }
    }
}

export async function listContracts({
    page = 1,
    limit = 25,
    type,
    year,
    nif,
    logger,
    Contract = ContractModel,
    fetchOfficial = fetchOfficialContracts,
    getFreshness = getSyncFreshness,
} = {}) {
    const nifNorm = nif == null || nif === '' ? null : normalizeNif(nif)
    if (nif != null && nif !== '' && !nifNorm) throw invalidNifError(nif)

    const query = buildListQuery({ type, year, nif: nifNorm })
    const paging = clampPageLimit(page, limit)
    const skip = (paging.page - 1) * paging.limit

    let data
    let total
    try {
        ;[data, total] = await Promise.all([
            runFind(Contract, query, {
                sort: { date: -1 },
                skip,
                limit: paging.limit,
                projection: LIST_PROJECTION,
            }),
            countContracts(Contract, query),
        ])
    } catch (err) {
        if (!isMaxTimeError(err)) throw err
        logger?.warn({ err }, 'List query hit maxTimeMS')
        data = []
        total = 0
    }

    const live = await maybeLiveFallback({
        nif: nifNorm,
        year,
        localCount: total,
        logger,
        Contract,
        fetchOfficial,
        getFreshness,
    })

    if (live.source === 'live') {
        try {
            ;[data, total] = await Promise.all([
                runFind(Contract, query, {
                    sort: { date: -1 },
                    skip,
                    limit: paging.limit,
                    projection: LIST_PROJECTION,
                }),
                countContracts(Contract, query),
            ])
        } catch (err) {
            if (!isMaxTimeError(err)) throw err
            logger?.warn({ err }, 'List query hit maxTimeMS after live fallback')
        }
    }

    return {
        total,
        page: paging.page,
        limit: paging.limit,
        pages: Math.ceil(total / paging.limit) || 0,
        source: live.source,
        ...(live.warning ? { warning: live.warning } : {}),
        data: data.map(toListItem),
    }
}

export async function searchContracts({
    q,
    nif,
    page = 1,
    limit = 25,
    from,
    to,
    year,
    logger,
    Contract = ContractModel,
    fetchOfficial = fetchOfficialContracts,
    getFreshness = getSyncFreshness,
    now,
} = {}) {
    const qTrim = q?.trim() ?? ''
    const nifParam = nif == null || nif === '' ? null : normalizeNif(nif)
    if (nif != null && nif !== '' && !nifParam) throw invalidNifError(nif)

    const nifFromQ = normalizeNif(qTrim)
    const nifNorm = nifParam || nifFromQ
    const textQ = nifFromQ && nifFromQ === qTrim ? '' : qTrim

    if (!textQ && !nifNorm) {
        const err = new Error('q or nif parameter is required')
        err.statusCode = 400
        throw err
    }
    if (textQ && !textMatchClause(textQ)) {
        const err = new Error('q must contain at least one word of 2+ characters')
        err.statusCode = 400
        throw err
    }

    const paging = clampPageLimit(page, limit)
    const skip = (paging.page - 1) * paging.limit
    const dateRange = textQ ? searchDateRange({ from, to, year, now }) : null
    const { data, total, warning: searchWarning } = await runSearch(Contract, {
        nifNorm,
        textQ,
        skip,
        limit: paging.limit,
        dateRange,
        logger,
    })

    const live = await maybeLiveFallback({
        nif: nifNorm,
        year,
        localCount: total,
        logger,
        Contract,
        fetchOfficial,
        getFreshness,
    })

    const refreshed = live.source === 'live'
        ? await runSearch(Contract, {
            nifNorm,
            textQ,
            skip,
            limit: paging.limit,
            dateRange,
            logger,
        })
        : { data, total, warning: searchWarning }

    const warning = live.warning || refreshed.warning
    return {
        query: qTrim || nifNorm,
        total: refreshed.total,
        page: paging.page,
        limit: paging.limit,
        pages: Math.ceil(refreshed.total / paging.limit) || 0,
        source: live.source,
        ...(warning ? { warning } : {}),
        data: refreshed.data.map(toListItem),
    }
}

export function escapeRegex(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function textMatchClause(textQ) {
    const words = String(textQ)
        .split(/\s+/)
        .map(w => w.trim())
        .filter(w => w.length >= 2)
        .map(w => new RegExp(escapeRegex(w), 'i'))
    if (!words.length) return null
    const fieldClause = re => ({
        $or: [
            { description: re },
            { contractingEntity: re },
            { awarded: re },
        ],
    })
    if (words.length === 1) return fieldClause(words[0])
    return { $and: words.map(fieldClause) }
}

function buildSearchQuery({ nifNorm, textQ, dateRange }) {
    const parts = []
    if (nifNorm) parts.push(nifClause(nifNorm))
    if (dateRange) parts.push({ date: dateRange })
    if (textQ) {
        const textClause = textMatchClause(textQ)
        if (textClause) parts.push(textClause)
    }
    if (parts.length === 0) return {}
    if (parts.length === 1) return parts[0]
    return { $and: parts }
}

async function runSearch(Contract, { nifNorm, textQ, skip, limit, dateRange, logger }) {
    const query = buildSearchQuery({ nifNorm, textQ, dateRange })
    try {
        const [data, total] = await Promise.all([
            runFind(Contract, query, {
                projection: LIST_PROJECTION,
                sort: { date: -1, synced_at: -1 },
                skip,
                limit,
                maxTimeMS: SEARCH_MAX_TIME_MS,
            }),
            countContracts(Contract, query, { maxTimeMS: SEARCH_MAX_TIME_MS }),
        ])
        return { data, total }
    } catch (err) {
        if (!isMaxTimeError(err)) throw err
        logger?.warn({ err }, 'Search query hit maxTimeMS')
        return { data: [], total: 0, warning: SEARCH_TIMEOUT_WARNING }
    }
}
